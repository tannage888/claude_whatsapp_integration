import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import express from "express";
import request from "supertest";
import { StateDb } from "../src/services/state-db.js";
import { MessageStore } from "../src/services/message-store.js";
import { GapDetector } from "../src/services/gap-detector.js";
import { createApiRouter } from "../src/routes/api.js";
import type { WhatsAppConnection } from "../src/services/whatsapp.js";
import type { WASocket } from "@whiskeysockets/baileys";

vi.mock("@whiskeysockets/baileys", () => ({
  default: vi.fn(),
  useMultiFileAuthState: vi.fn(),
  fetchLatestBaileysVersion: vi.fn(),
  makeCacheableSignalKeyStore: vi.fn((k: unknown) => k),
  DisconnectReason: { loggedOut: 401 },
}));

const JID = "447700900123@s.whatsapp.net";
const GROUP_JID = "12345678901-1234567890@g.us";

function buildApp(db: StateDb, store: MessageStore) {
  const fakeWa = { store, getStatus: () => "connected", getQr: () => null, getPairingCode: () => null, wipeAuthState: () => {}, getSocket: () => null } as unknown as WhatsAppConnection;
  const app = express();
  app.use(express.json());
  app.use("/api", createApiRouter({
    startedAt: Date.now(),
    version: "test",
    getConnectionStatus: () => "connected",
    whatsapp: fakeWa,
    db,
    authStatePath: "/tmp/auth",
  }));
  return app;
}

describe("Phase 8: Gap detection + history backfill", () => {
  let db: StateDb;
  let store: MessageStore;

  beforeEach(() => {
    db = new StateDb(":memory:");
    store = new MessageStore(":memory-unused:");
  });

  afterEach(() => {
    db.close();
  });

  it("records gap row for chat with downtime > 60s", async () => {
    const oldTs = Date.now() - 120_000; // 2 min ago
    db.upsertChat({ jid: JID, isGroup: false, lastSeenByDaemonAt: oldTs });

    const detector = new GapDetector(db, store, () => null);
    const result = await detector.detectAndBackfill();

    expect(result.gapsRecorded).toBe(1);
    const gaps = db.listGaps();
    expect(gaps).toHaveLength(1);
    expect(gaps[0].chatJid).toBe(JID);
    expect(gaps[0].reason).toBe("gateway_offline");
  });

  it("does not record gap when downtime < 60s", async () => {
    const recentTs = Date.now() - 30_000; // 30s ago
    db.upsertChat({ jid: JID, isGroup: false, lastSeenByDaemonAt: recentTs });

    const detector = new GapDetector(db, store, () => null);
    await detector.detectAndBackfill();

    expect(db.listGaps()).toHaveLength(0);
  });

  it("mocked fetchMessageHistory returns messages → backfill_succeeded=true", async () => {
    const gapFrom = Date.now() - 120_000;
    const msgTs = Math.floor((gapFrom + 60_000) / 1000); // inside gap window

    const mockSocket = {
      fetchMessageHistory: vi.fn().mockResolvedValue({
        messages: [
          {
            key: { remoteJid: JID, fromMe: false, id: "HIST001" },
            message: { conversation: "Historical message" },
            messageTimestamp: msgTs,
          },
        ],
        cursor: null,
      }),
    } as unknown as WASocket;

    db.upsertChat({ jid: JID, isGroup: false, lastSeenByDaemonAt: gapFrom });

    const detector = new GapDetector(db, store, () => mockSocket);
    await detector.detectAndBackfill();

    const gaps = db.listGaps();
    expect(gaps[0].backfillAttempted).toBe(true);
    expect(gaps[0].backfillSucceeded).toBe(true);
  });

  it("empty fetchMessageHistory response → backfill_attempted but not succeeded", async () => {
    const gapFrom = Date.now() - 120_000;

    const mockSocket = {
      fetchMessageHistory: vi.fn().mockResolvedValue({ messages: [], cursor: null }),
    } as unknown as WASocket;

    db.upsertChat({ jid: JID, isGroup: false, lastSeenByDaemonAt: gapFrom });

    const detector = new GapDetector(db, store, () => mockSocket);
    await detector.detectAndBackfill();

    const gaps = db.listGaps();
    expect(gaps[0].backfillAttempted).toBe(true);
    expect(gaps[0].backfillSucceeded).toBe(false);
  });

  it("gap surfaces in transcript response", async () => {
    db.recordGap({ chatJid: JID, fromTs: Date.now() - 5000, toTs: Date.now() - 1000, reason: "gateway_offline", backfillAttempted: true, backfillSucceeded: false });

    const app = buildApp(db, store);
    const res = await request(app).get(`/api/chats/${encodeURIComponent(JID)}/messages?mode=full`);
    expect(res.body.gaps).toHaveLength(1);
    expect(res.body.gaps[0].backfillAttempted).toBe(true);
    expect(res.body.gaps[0].backfillSucceeded).toBe(false);
  });

  it("GET /api/gaps lists all gaps", async () => {
    db.recordGap({ chatJid: JID, fromTs: 1000, toTs: 2000, reason: "gateway_offline", backfillAttempted: false, backfillSucceeded: false });
    const app = buildApp(db, store);

    const res = await request(app).get("/api/gaps");
    expect(res.status).toBe(200);
    expect(res.body.gaps).toHaveLength(1);
  });

  it("POST /api/gaps/:id/resolve marks gap resolved", async () => {
    const id = db.recordGap({ chatJid: JID, fromTs: 1000, toTs: 2000, reason: "gateway_offline", backfillAttempted: true, backfillSucceeded: false });
    const app = buildApp(db, store);

    const res = await request(app).post(`/api/gaps/${id}/resolve`);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(db.getGap(id)!.resolvedAt).not.toBeNull();
  });

  it("touchChat updates last_seen_by_daemon_at", () => {
    db.upsertChat({ jid: JID, isGroup: false, lastSeenByDaemonAt: 1000 });
    const detector = new GapDetector(db, store, () => null);
    detector.touchChat(JID);
    const chat = db.getChat(JID);
    expect(chat!.lastSeenByDaemonAt).toBeGreaterThan(1000);
  });
});
