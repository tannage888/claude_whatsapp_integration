import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import express from "express";
import request from "supertest";
import { StateDb } from "../src/services/state-db.js";
import { MessageStore } from "../src/services/message-store.js";
import { GapDetector, NO_EVIDENCE_NOTE } from "../src/services/gap-detector.js";
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

  /** A stored message for JID at `tsMs`. */
  function message(tsMs: number, jid = JID, id = "M1") {
    return {
      key: { remoteJid: jid, fromMe: false, id },
      message: { conversation: "hi" },
      messageTimestamp: Math.floor(tsMs / 1000),
    };
  }

  it("records gap row for chat with downtime > 60s", () => {
    const oldTs = Date.now() - 120_000; // 2 min ago
    db.upsertChat({ jid: JID, isGroup: false, lastSeenByDaemonAt: oldTs });

    const result = new GapDetector(db, store).detect();

    expect(result.gapsRecorded).toBe(1);
    const gaps = db.listGaps();
    expect(gaps).toHaveLength(1);
    expect(gaps[0].chatJid).toBe(JID);
    expect(gaps[0].reason).toBe("gateway_offline");
  });

  it("does not record gap when downtime < 60s", () => {
    const recentTs = Date.now() - 30_000; // 30s ago
    db.upsertChat({ jid: JID, isGroup: false, lastSeenByDaemonAt: recentTs });

    new GapDetector(db, store).detect();

    expect(db.listGaps()).toHaveLength(0);
  });

  it("resolves a gap at detection when the store already covers the window", () => {
    const gapFrom = Date.now() - 120_000;
    db.upsertChat({ jid: JID, isGroup: false, lastSeenByDaemonAt: gapFrom });
    store.buffer([message(gapFrom + 60_000)] as never);

    const result = new GapDetector(db, store).detect();

    expect(result.gapsRecorded).toBe(1);
    expect(result.alreadyCovered).toBe(1);
    const gaps = db.listGaps();
    expect(gaps[0].backfillSucceeded).toBe(true);
    expect(gaps[0].resolvedAt).not.toBeNull();
  });

  it("leaves the gap open when history has not arrived yet", () => {
    // The regression this whole class exists for: at startup the reconnect
    // history sync has not landed, so an open gap must NOT be judged failed.
    const gapFrom = Date.now() - 120_000;
    db.upsertChat({ jid: JID, isGroup: false, lastSeenByDaemonAt: gapFrom });

    new GapDetector(db, store).detect();

    const gaps = db.listGaps();
    expect(gaps[0].backfillSucceeded).toBe(false);
    expect(gaps[0].resolvedAt).toBeNull();
    expect(db.listGaps(true)).toHaveLength(1);
  });

  it("reviewOpenGaps closes the gap once history lands", () => {
    const gapFrom = Date.now() - 120_000;
    db.upsertChat({ jid: JID, isGroup: false, lastSeenByDaemonAt: gapFrom });

    const detector = new GapDetector(db, store);
    detector.detect();
    expect(db.listGaps(true)).toHaveLength(1);

    // History sync delivers a message from inside the window.
    store.buffer([message(gapFrom + 60_000)] as never);

    expect(detector.reviewOpenGaps()).toBe(1);
    const gaps = db.listGaps();
    expect(gaps[0].backfillAttempted).toBe(true);
    expect(gaps[0].backfillSucceeded).toBe(true);
    expect(gaps[0].resolvedAt).not.toBeNull();
  });

  it("reviewOpenGaps leaves the gap open when history falls outside the window", () => {
    const gapFrom = Date.now() - 120_000;
    db.upsertChat({ jid: JID, isGroup: false, lastSeenByDaemonAt: gapFrom });

    const detector = new GapDetector(db, store);
    detector.detect();

    // Older than the gap — does not prove the window was recovered.
    store.buffer([message(gapFrom - 60_000)] as never);

    expect(detector.reviewOpenGaps()).toBe(0);
    expect(db.listGaps(true)).toHaveLength(1);
  });

  it("closes a gap keyed by @lid when the messages are filed under the phone JID", () => {
    const lid = "26250957574355@lid";
    const gapFrom = Date.now() - 120_000;
    db.upsertChat({ jid: lid, isGroup: false, lastSeenByDaemonAt: gapFrom });

    const detector = new GapDetector(db, store);
    detector.detect();

    // buffer() re-files @lid traffic under the phone JID once the pairing is
    // known, so the gap's own key no longer matches where the messages live.
    store.registerLid(lid, JID);
    store.buffer([message(gapFrom + 60_000, lid)] as never);

    expect(detector.reviewOpenGaps()).toBe(1);
    expect(db.listGaps(true)).toHaveLength(0);
  });

  it("does not record a gap for @broadcast, which the store never keeps", () => {
    db.upsertChat({ jid: 'status@broadcast', isGroup: false, lastSeenByDaemonAt: Date.now() - 120_000 });

    const result = new GapDetector(db, store).detect();

    expect(result.gapsRecorded).toBe(0);
    expect(db.listGaps()).toHaveLength(0);
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
    const detector = new GapDetector(db, store);
    detector.touchChat(JID);
    const chat = db.getChat(JID);
    expect(chat!.lastSeenByDaemonAt).toBeGreaterThan(1000);
  });

  describe("settleQuietGaps", () => {
    it("closes an uncovered gateway_offline gap as unrecovered, not as a success", () => {
      const gapFrom = Date.now() - 120_000;
      db.upsertChat({ jid: JID, isGroup: false, lastSeenByDaemonAt: gapFrom });

      const detector = new GapDetector(db, store);
      detector.detect();
      expect(db.listGaps(true)).toHaveLength(1);

      // History sync completed and brought nothing for this chat.
      expect(detector.settleQuietGaps()).toBe(1);

      const gap = db.listGaps()[0];
      expect(gap.resolvedAt).not.toBeNull();
      expect(gap.notes).toBe(NO_EVIDENCE_NOTE);
      // Nothing was recovered, so the success flag must not claim otherwise.
      expect(gap.backfillSucceeded).toBe(false);
    });

    it("leaves decrypt_failure gaps open — those messages are known to have existed", () => {
      db.recordGap({
        chatJid: JID, fromTs: Date.now() - 120_000, toTs: Date.now() - 60_000,
        reason: "decrypt_failure", backfillAttempted: false, backfillSucceeded: false,
      });

      expect(new GapDetector(db, store).settleQuietGaps()).toBe(0);
      expect(db.listGaps(true)).toHaveLength(1);
    });

    it("leaves a covered gap for reviewOpenGaps to close as recovered", () => {
      const gapFrom = Date.now() - 120_000;
      db.upsertChat({ jid: JID, isGroup: false, lastSeenByDaemonAt: gapFrom });

      const detector = new GapDetector(db, store);
      detector.detect();
      store.buffer([message(gapFrom + 60_000)] as never);

      expect(detector.settleQuietGaps()).toBe(0);
      expect(detector.reviewOpenGaps()).toBe(1);
      expect(db.listGaps()[0].backfillSucceeded).toBe(true);
    });

    it("is idempotent — a settled gap is not counted again", () => {
      db.upsertChat({ jid: JID, isGroup: false, lastSeenByDaemonAt: Date.now() - 120_000 });
      const detector = new GapDetector(db, store);
      detector.detect();

      expect(detector.settleQuietGaps()).toBe(1);
      expect(detector.settleQuietGaps()).toBe(0);
    });

    it("clears the per-restart backlog a quiet chat accumulates", () => {
      // One unclosable row per daemon start is what buries the real gaps.
      for (let i = 5; i > 0; i--) {
        db.recordGap({
          chatJid: JID, fromTs: Date.now() - i * 60_000, toTs: Date.now() - (i - 1) * 60_000,
          reason: "gateway_offline", backfillAttempted: false, backfillSucceeded: false,
        });
      }
      db.recordGap({
        chatJid: GROUP_JID, fromTs: Date.now() - 60_000, toTs: Date.now(),
        reason: "decrypt_failure", backfillAttempted: false, backfillSucceeded: false,
      });

      expect(new GapDetector(db, store).settleQuietGaps()).toBe(5);

      const open = db.listGaps(true);
      expect(open).toHaveLength(1);
      expect(open[0].reason).toBe("decrypt_failure");
    });
  });

  describe("GET /api/gaps summary", () => {
    it("breaks unresolved gaps down by reason", async () => {
      db.recordGap({ chatJid: JID, fromTs: 1000, toTs: 2000, reason: "gateway_offline", backfillAttempted: false, backfillSucceeded: false });
      db.recordGap({ chatJid: JID, fromTs: 3000, toTs: 4000, reason: "decrypt_failure", backfillAttempted: false, backfillSucceeded: false });
      const resolved = db.recordGap({ chatJid: JID, fromTs: 5000, toTs: 6000, reason: "gateway_offline", backfillAttempted: true, backfillSucceeded: true });
      db.resolveGap(resolved);

      const res = await request(buildApp(db, store)).get("/api/gaps");

      expect(res.status).toBe(200);
      expect(res.body.gaps).toHaveLength(3);
      expect(res.body.summary).toEqual({
        total: 3,
        unresolved: 2,
        resolved: 1,
        unresolvedByReason: { gateway_offline: 1, decrypt_failure: 1 },
      });
    });

    it("?unresolved=true returns only open gaps, with the summary still counting all", async () => {
      db.recordGap({ chatJid: JID, fromTs: 1000, toTs: 2000, reason: "decrypt_failure", backfillAttempted: false, backfillSucceeded: false });
      const resolved = db.recordGap({ chatJid: JID, fromTs: 3000, toTs: 4000, reason: "gateway_offline", backfillAttempted: true, backfillSucceeded: true });
      db.resolveGap(resolved);

      const res = await request(buildApp(db, store)).get("/api/gaps?unresolved=true");

      expect(res.status).toBe(200);
      expect(res.body.gaps).toHaveLength(1);
      expect(res.body.gaps[0].reason).toBe("decrypt_failure");
      expect(res.body.summary.total).toBe(2);
      expect(res.body.summary.unresolved).toBe(1);
    });
  });
});
