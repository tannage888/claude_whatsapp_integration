import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import express from "express";
import request from "supertest";
import { StateDb } from "../src/services/state-db.js";
import { MessageStore } from "../src/services/message-store.js";
import { MembershipService } from "../src/services/membership.js";
import { ContactContextScraper } from "../src/services/contact-context-scraper.js";
import { createApiRouter } from "../src/routes/api.js";
import type { WhatsAppConnection } from "../src/services/whatsapp.js";
import type { WASocket } from "@whiskeysockets/baileys";

const CONTACT_E164 = "+447700900123";
const CONTACT_JID = "447700900123@s.whatsapp.net";
const GROUP_JID_A = "120363000000000001@g.us";
const GROUP_JID_B = "120363000000000002@g.us";

function makeMsg(jid: string, tsSec: number, body: string, id: string) {
  return {
    key: { remoteJid: jid, fromMe: false, id },
    message: { conversation: body },
    messageTimestamp: tsSec,
  };
}

describe("Phase 13: Contact context scraper", () => {
  let db: StateDb;
  let store: MessageStore;
  let tmpDir: string;
  let fetchMessageHistoryMock: ReturnType<typeof vi.fn>;
  let groupFetchMock: ReturnType<typeof vi.fn>;
  let mockSocket: Partial<WASocket>;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "wa-scraper-test-"));
    db = new StateDb(":memory:");
    store = new MessageStore(path.join(tmpDir, "store.json"));
    fetchMessageHistoryMock = vi.fn();
    groupFetchMock = vi.fn().mockResolvedValue({});
    mockSocket = {
      // @ts-expect-error fetchMessageHistory is not in the official types but exists at runtime
      fetchMessageHistory: fetchMessageHistoryMock,
      groupFetchAllParticipating: groupFetchMock,
    } as unknown as Partial<WASocket>;
  });

  afterEach(() => {
    db.close();
    if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function buildScraper(): { scraper: ContactContextScraper; membership: MembershipService } {
    const membership = new MembershipService(db, () => mockSocket as WASocket);
    const scraper = new ContactContextScraper(db, store, membership, () => mockSocket as WASocket);
    return { scraper, membership };
  }

  it("resolves identifier (E164) to JID and includes direct chat", async () => {
    fetchMessageHistoryMock.mockResolvedValue({ messages: [], cursor: null });
    const { scraper } = buildScraper();

    const result = await scraper.scrape(CONTACT_E164);

    expect(result.contactJid).toBe(CONTACT_JID);
    expect(result.chats.some((c) => c.jid === CONTACT_JID)).toBe(true);
  });

  it("fetches history for each chat the contact belongs to", async () => {
    db.upsertChatMember({ chatJid: GROUP_JID_A, participantJid: CONTACT_JID, displayName: "Alice", lastVerifiedAt: Date.now() });
    db.upsertChatMember({ chatJid: GROUP_JID_B, participantJid: CONTACT_JID, displayName: "Alice", lastVerifiedAt: Date.now() });

    const nowSec = Math.floor(Date.now() / 1000);
    fetchMessageHistoryMock.mockImplementation((jid: string) => {
      if (jid === GROUP_JID_A) return Promise.resolve({ messages: [makeMsg(jid, nowSec, "hi from A", "m1")], cursor: null });
      if (jid === GROUP_JID_B) return Promise.resolve({ messages: [makeMsg(jid, nowSec, "hi from B", "m2"), makeMsg(jid, nowSec - 10, "older", "m3")], cursor: null });
      return Promise.resolve({ messages: [], cursor: null });
    });

    const { scraper } = buildScraper();
    const result = await scraper.scrape(CONTACT_E164);

    const aChat = result.chats.find((c) => c.jid === GROUP_JID_A);
    const bChat = result.chats.find((c) => c.jid === GROUP_JID_B);
    expect(aChat?.messagesBackfilled).toBe(1);
    expect(bChat?.messagesBackfilled).toBe(2);
    expect(result.totalMessagesBackfilled).toBeGreaterThanOrEqual(3);
    expect(store.get(GROUP_JID_A)).toHaveLength(1);
    expect(store.get(GROUP_JID_B)).toHaveLength(2);
  });

  it("triggers membership.refresh() when cache is empty", async () => {
    // No members in DB yet. Refresh will populate one group.
    groupFetchMock.mockResolvedValue({
      [GROUP_JID_A]: {
        subject: "Project Crew",
        participants: [{ id: CONTACT_JID }, { id: "447700900124@s.whatsapp.net" }],
      },
    });
    fetchMessageHistoryMock.mockResolvedValue({ messages: [], cursor: null });

    const { scraper } = buildScraper();
    const result = await scraper.scrape(CONTACT_E164);

    expect(groupFetchMock).toHaveBeenCalled();
    expect(result.membershipRefreshed).toBe(true);
    expect(result.chats.some((c) => c.jid === GROUP_JID_A)).toBe(true);
  });

  it("paginates using cursor and stops when cap reached", async () => {
    db.upsertChatMember({ chatJid: GROUP_JID_A, participantJid: CONTACT_JID, displayName: null, lastVerifiedAt: Date.now() });

    const nowSec = Math.floor(Date.now() / 1000);
    const makeBatch = (prefix: string, start: number, count: number) =>
      Array.from({ length: count }, (_, i) => makeMsg(GROUP_JID_A, nowSec - (start + i), `msg-${prefix}-${i}`, `${prefix}${i}`));

    fetchMessageHistoryMock
      .mockResolvedValueOnce({ messages: makeBatch("A", 0, 50), cursor: "cur1" })
      .mockResolvedValueOnce({ messages: makeBatch("B", 50, 50), cursor: "cur2" })
      .mockResolvedValueOnce({ messages: makeBatch("C", 100, 50), cursor: null });

    const { scraper } = buildScraper();
    const result = await scraper.scrape(CONTACT_E164, { maxMessagesPerChat: 100 });

    const a = result.chats.find((c) => c.jid === GROUP_JID_A);
    expect(a?.messagesBackfilled).toBe(100);
    expect(fetchMessageHistoryMock.mock.calls.filter((call) => call[0] === GROUP_JID_A)).toHaveLength(2);
  });

  it("respects the since floor to stop pagination early", async () => {
    db.upsertChatMember({ chatJid: GROUP_JID_A, participantJid: CONTACT_JID, displayName: null, lastVerifiedAt: Date.now() });

    const cutoff = new Date("2026-03-01T00:00:00Z");
    const sinceSec = Math.floor(cutoff.getTime() / 1000);

    fetchMessageHistoryMock
      .mockResolvedValueOnce({
        messages: [
          makeMsg(GROUP_JID_A, sinceSec + 100, "new", "n1"),
          makeMsg(GROUP_JID_A, sinceSec - 100, "already too old", "n2"),
        ],
        cursor: "cur1",
      });

    const { scraper } = buildScraper();
    const result = await scraper.scrape(CONTACT_E164, { since: cutoff.toISOString() });

    const a = result.chats.find((c) => c.jid === GROUP_JID_A);
    expect(a?.messagesBackfilled).toBe(2);
    expect(fetchMessageHistoryMock.mock.calls.filter((call) => call[0] === GROUP_JID_A)).toHaveLength(1);
  });

  it("returns zero messages gracefully when socket is null", async () => {
    db.upsertChatMember({ chatJid: GROUP_JID_A, participantJid: CONTACT_JID, displayName: null, lastVerifiedAt: Date.now() });
    const membership = new MembershipService(db, () => null);
    const scraper = new ContactContextScraper(db, store, membership, () => null);

    const result = await scraper.scrape(CONTACT_E164);
    expect(result.totalMessagesBackfilled).toBe(0);
  });

  it("handles fetchMessageHistory throwing without crashing", async () => {
    db.upsertChatMember({ chatJid: GROUP_JID_A, participantJid: CONTACT_JID, displayName: null, lastVerifiedAt: Date.now() });
    fetchMessageHistoryMock.mockRejectedValue(new Error("boom"));

    const { scraper } = buildScraper();
    const result = await scraper.scrape(CONTACT_E164);
    expect(result.chats.find((c) => c.jid === GROUP_JID_A)?.messagesBackfilled).toBe(0);
  });

  describe("REST endpoint", () => {
    function buildApp(scraper: ContactContextScraper) {
      const fakeWa = { store, getStatus: () => "connected", getQr: () => null, getPairingCode: () => null, wipeAuthState: () => {}, getSocket: () => mockSocket } as unknown as WhatsAppConnection;
      const app = express();
      app.use(express.json());
      app.use("/api", createApiRouter({
        startedAt: Date.now(),
        version: "test",
        getConnectionStatus: () => "connected",
        whatsapp: fakeWa,
        db,
        membership: new MembershipService(db, () => mockSocket as WASocket),
        contextScraper: scraper,
        authStatePath: "/tmp/auth",
      }));
      return app;
    }

    it("POST /api/contacts/:identifier/scrape-context returns scrape result", async () => {
      db.upsertChatMember({ chatJid: GROUP_JID_A, participantJid: CONTACT_JID, displayName: null, lastVerifiedAt: Date.now() });
      fetchMessageHistoryMock.mockResolvedValue({
        messages: [makeMsg(GROUP_JID_A, Math.floor(Date.now() / 1000), "yo", "x1")],
        cursor: null,
      });

      const { scraper } = buildScraper();
      const app = buildApp(scraper);
      const res = await request(app)
        .post(`/api/contacts/${encodeURIComponent(CONTACT_E164)}/scrape-context`)
        .send({ maxMessagesPerChat: 100 });

      expect(res.status).toBe(200);
      expect(res.body.contactJid).toBe(CONTACT_JID);
      expect(res.body.totalMessagesBackfilled).toBeGreaterThan(0);
      expect(Array.isArray(res.body.chats)).toBe(true);
    });

    it("POST without body still works (uses defaults)", async () => {
      fetchMessageHistoryMock.mockResolvedValue({ messages: [], cursor: null });
      const { scraper } = buildScraper();
      const app = buildApp(scraper);

      const res = await request(app).post(`/api/contacts/${encodeURIComponent(CONTACT_E164)}/scrape-context`);
      expect(res.status).toBe(200);
      expect(res.body.contactJid).toBe(CONTACT_JID);
    });
  });
});
