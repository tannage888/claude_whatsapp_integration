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
import type { HistoryBatch, HistoryFetcher } from "../src/services/history-fetcher.js";
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
  let historyMock: ReturnType<typeof vi.fn>;
  let groupFetchMock: ReturnType<typeof vi.fn>;
  let mockSocket: Partial<WASocket>;

  /**
   * Stands in for HistoryFetcher. Batches are buffered into the store exactly
   * as WhatsAppConnection's `messaging-history.set` handler does in production
   * — the scraper itself never stores, it only counts.
   */
  function batch(messages: ReturnType<typeof makeMsg>[], isLatest = false): HistoryBatch {
    store.buffer(messages as never);
    return { messages: messages as never, isLatest, timedOut: false };
  }

  function emptyBatch(isLatest = true): HistoryBatch {
    return { messages: [], isLatest, timedOut: false };
  }

  function historyFetcher(): HistoryFetcher {
    return { fetchOlderThan: historyMock } as unknown as HistoryFetcher;
  }

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "wa-scraper-test-"));
    db = new StateDb(":memory:");
    store = new MessageStore(path.join(tmpDir, "store.json"));
    historyMock = vi.fn().mockResolvedValue({ messages: [], isLatest: true, timedOut: false });
    groupFetchMock = vi.fn().mockResolvedValue({});
    mockSocket = {
      groupFetchAllParticipating: groupFetchMock,
    } as unknown as Partial<WASocket>;
  });

  afterEach(() => {
    db.close();
    if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function buildScraper(): { scraper: ContactContextScraper; membership: MembershipService } {
    const membership = new MembershipService(db, () => mockSocket as WASocket);
    const scraper = new ContactContextScraper(
      db,
      store,
      membership,
      () => mockSocket as WASocket,
      historyFetcher()
    );
    return { scraper, membership };
  }

  /** Seed one stored message so the chat has an anchor to page back from. */
  function seedAnchor(jid: string, tsSec = Math.floor(Date.now() / 1000)) {
    store.buffer([makeMsg(jid, tsSec, "seed", `seed-${jid}`)] as never);
  }

  it("resolves identifier (E164) to JID and includes direct chat", async () => {
    const { scraper } = buildScraper();

    const result = await scraper.scrape(CONTACT_E164);

    expect(result.contactJid).toBe(CONTACT_JID);
    expect(result.chats.some((c) => c.jid === CONTACT_JID)).toBe(true);
  });

  it("fetches history for each chat the contact belongs to", async () => {
    db.upsertChatMember({ chatJid: GROUP_JID_A, participantJid: CONTACT_JID, displayName: "Alice", lastVerifiedAt: Date.now() });
    db.upsertChatMember({ chatJid: GROUP_JID_B, participantJid: CONTACT_JID, displayName: "Alice", lastVerifiedAt: Date.now() });

    const nowSec = Math.floor(Date.now() / 1000);
    seedAnchor(GROUP_JID_A, nowSec);
    seedAnchor(GROUP_JID_B, nowSec);

    historyMock.mockImplementation((anchor: { key: { remoteJid: string } }) => {
      const jid = anchor.key.remoteJid;
      if (jid === GROUP_JID_A) {
        return Promise.resolve(batch([makeMsg(jid, nowSec - 100, "hi from A", "m1")], true));
      }
      if (jid === GROUP_JID_B) {
        return Promise.resolve(
          batch([makeMsg(jid, nowSec - 100, "hi from B", "m2"), makeMsg(jid, nowSec - 110, "older", "m3")], true)
        );
      }
      return Promise.resolve(emptyBatch());
    });

    const { scraper } = buildScraper();
    const result = await scraper.scrape(CONTACT_E164);

    expect(result.chats.find((c) => c.jid === GROUP_JID_A)?.messagesBackfilled).toBe(1);
    expect(result.chats.find((c) => c.jid === GROUP_JID_B)?.messagesBackfilled).toBe(2);
    expect(result.totalMessagesBackfilled).toBeGreaterThanOrEqual(3);
  });

  it("anchors each request on the oldest message held for the chat", async () => {
    db.upsertChatMember({ chatJid: GROUP_JID_A, participantJid: CONTACT_JID, displayName: null, lastVerifiedAt: Date.now() });

    const nowSec = Math.floor(Date.now() / 1000);
    store.buffer([
      makeMsg(GROUP_JID_A, nowSec, "newest", "new"),
      makeMsg(GROUP_JID_A, nowSec - 500, "oldest", "old"),
    ] as never);
    historyMock.mockResolvedValue(emptyBatch());

    const { scraper } = buildScraper();
    await scraper.scrape(CONTACT_E164);

    const call = historyMock.mock.calls.find((c) => c[0].key.remoteJid === GROUP_JID_A);
    expect(call?.[0].key.id).toBe("old");
    expect(call?.[0].timestampSec).toBe(nowSec - 500);
    // The count is the second argument, mirroring Baileys'
    // fetchMessageHistory(count, oldestMsgKey, oldestMsgTimestamp).
    expect(call?.[1]).toBe(50);
  });

  it("skips a chat with nothing stored — there is no cursor to page back from", async () => {
    db.upsertChatMember({ chatJid: GROUP_JID_A, participantJid: CONTACT_JID, displayName: null, lastVerifiedAt: Date.now() });

    const { scraper } = buildScraper();
    const result = await scraper.scrape(CONTACT_E164);

    const a = result.chats.find((c) => c.jid === GROUP_JID_A);
    expect(a?.messagesBackfilled).toBe(0);
    expect(a?.skipped).toBe("no-anchor");
    expect(historyMock).not.toHaveBeenCalled();
  });

  it("triggers membership.refresh() when cache is empty", async () => {
    // No members in DB yet. Refresh will populate one group.
    groupFetchMock.mockResolvedValue({
      [GROUP_JID_A]: {
        subject: "Project Crew",
        participants: [{ id: CONTACT_JID }, { id: "447700900124@s.whatsapp.net" }],
      },
    });

    const { scraper } = buildScraper();
    const result = await scraper.scrape(CONTACT_E164);

    expect(groupFetchMock).toHaveBeenCalled();
    expect(result.membershipRefreshed).toBe(true);
    expect(result.chats.some((c) => c.jid === GROUP_JID_A)).toBe(true);
  });

  it("paginates backwards and stops when the cap is reached", async () => {
    db.upsertChatMember({ chatJid: GROUP_JID_A, participantJid: CONTACT_JID, displayName: null, lastVerifiedAt: Date.now() });

    const nowSec = Math.floor(Date.now() / 1000);
    seedAnchor(GROUP_JID_A, nowSec);

    let page = 0;
    historyMock.mockImplementation(() => {
      const start = 100 + page * 50;
      page++;
      return Promise.resolve(
        batch(
          Array.from({ length: 50 }, (_, i) =>
            makeMsg(GROUP_JID_A, nowSec - (start + i), "msg", `p${page}-${i}`)
          )
        )
      );
    });

    const { scraper } = buildScraper();
    const result = await scraper.scrape(CONTACT_E164, { maxMessagesPerChat: 100 });

    expect(result.chats.find((c) => c.jid === GROUP_JID_A)?.messagesBackfilled).toBe(100);
    expect(historyMock.mock.calls.filter((c) => c[0].key.remoteJid === GROUP_JID_A)).toHaveLength(2);
  });

  it("stops paging once WhatsApp reports the end of history", async () => {
    db.upsertChatMember({ chatJid: GROUP_JID_A, participantJid: CONTACT_JID, displayName: null, lastVerifiedAt: Date.now() });
    const nowSec = Math.floor(Date.now() / 1000);
    seedAnchor(GROUP_JID_A, nowSec);

    // Lazy: batch() buffers into the store, which has to happen when the
    // scraper calls, not when the mock is configured.
    historyMock.mockImplementation(() =>
      Promise.resolve(batch([makeMsg(GROUP_JID_A, nowSec - 100, "only", "o1")], true))
    );

    const { scraper } = buildScraper();
    const result = await scraper.scrape(CONTACT_E164, { maxMessagesPerChat: 500 });

    expect(result.chats.find((c) => c.jid === GROUP_JID_A)?.messagesBackfilled).toBe(1);
    expect(historyMock.mock.calls.filter((c) => c[0].key.remoteJid === GROUP_JID_A)).toHaveLength(1);
  });

  it("respects the since floor to stop pagination early", async () => {
    db.upsertChatMember({ chatJid: GROUP_JID_A, participantJid: CONTACT_JID, displayName: null, lastVerifiedAt: Date.now() });

    const cutoff = new Date("2026-03-01T00:00:00Z");
    const sinceSec = Math.floor(cutoff.getTime() / 1000);
    seedAnchor(GROUP_JID_A, sinceSec + 100);

    historyMock.mockImplementationOnce(() =>
      Promise.resolve(batch([makeMsg(GROUP_JID_A, sinceSec - 100, "already too old", "n2")]))
    );

    const { scraper } = buildScraper();
    const result = await scraper.scrape(CONTACT_E164, { since: cutoff.toISOString() });

    expect(result.chats.find((c) => c.jid === GROUP_JID_A)?.messagesBackfilled).toBe(1);
    // That batch pushed the anchor past the floor, so no second request goes out.
    expect(historyMock.mock.calls.filter((c) => c[0].key.remoteJid === GROUP_JID_A)).toHaveLength(1);
  });

  it("returns zero messages gracefully when socket is null", async () => {
    db.upsertChatMember({ chatJid: GROUP_JID_A, participantJid: CONTACT_JID, displayName: null, lastVerifiedAt: Date.now() });
    const membership = new MembershipService(db, () => null);
    const scraper = new ContactContextScraper(db, store, membership, () => null, historyFetcher());

    const result = await scraper.scrape(CONTACT_E164);
    expect(result.totalMessagesBackfilled).toBe(0);
  });

  it("handles a history request throwing without crashing the scrape", async () => {
    db.upsertChatMember({ chatJid: GROUP_JID_A, participantJid: CONTACT_JID, displayName: null, lastVerifiedAt: Date.now() });
    seedAnchor(GROUP_JID_A);
    historyMock.mockRejectedValue(new Error("boom"));

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
      const nowSec = Math.floor(Date.now() / 1000);
      seedAnchor(GROUP_JID_A, nowSec);
      historyMock.mockImplementation(() =>
        Promise.resolve(batch([makeMsg(GROUP_JID_A, nowSec - 100, "yo", "x1")], true))
      );

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
      const { scraper } = buildScraper();
      const app = buildApp(scraper);

      const res = await request(app).post(`/api/contacts/${encodeURIComponent(CONTACT_E164)}/scrape-context`);
      expect(res.status).toBe(200);
      expect(res.body.contactJid).toBe(CONTACT_JID);
    });
  });
});
