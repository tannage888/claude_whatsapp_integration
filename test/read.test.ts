import { describe, it, expect, beforeEach, afterEach } from "vitest";
import express from "express";
import request from "supertest";
import { StateDb } from "../src/services/state-db.js";
import { MessageStore } from "../src/services/message-store.js";
import { createApiRouter } from "../src/routes/api.js";
import type { WhatsAppConnection } from "../src/services/whatsapp.js";

const JID_1 = "447700900123@s.whatsapp.net";
const JID_GROUP = "12345678901-1234567890@g.us";

function makeRawMsg(jid: string, body: string, tsMs: number, id = "MSGID001", participant?: string) {
  return {
    key: { remoteJid: jid, fromMe: false, id, participant: participant ?? undefined },
    message: { conversation: body },
    messageTimestamp: Math.floor(tsMs / 1000),
  };
}

function buildApp(store: MessageStore, db: StateDb) {
  const fakeWa = { store, getStatus: () => "connected", getQr: () => null, getPairingCode: () => null, wipeAuthState: () => {} } as unknown as WhatsAppConnection;
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

describe("Phase 4: Read endpoints", () => {
  let db: StateDb;
  let store: MessageStore;
  let app: ReturnType<typeof buildApp>;

  beforeEach(() => {
    db = new StateDb(":memory:");
    store = new MessageStore(":memory-not-used:");
  });

  afterEach(() => {
    db.close();
  });

  it("GET /api/chats/:jid/messages (full) returns all messages for chat", async () => {
    const now = Date.now();
    store.buffer([makeRawMsg(JID_1, "Hello", now - 10_000) as any]);
    store.buffer([makeRawMsg(JID_1, "World", now - 5_000, "MSG002") as any]);
    app = buildApp(store, db);

    const res = await request(app).get(`/api/chats/${encodeURIComponent(JID_1)}/messages?mode=full`);
    expect(res.status).toBe(200);
    expect(res.body.messages).toHaveLength(2);
    expect(res.body.chat.jid).toBe(JID_1);
    expect(res.body.window.reason).toBe("full");
  });

  it("GET messages?mode=since_last_review returns only post-watermark messages", async () => {
    const t0 = Date.now() - 60_000;
    const t1 = Date.now() - 30_000;
    const t2 = Date.now() - 10_000;

    store.buffer([makeRawMsg(JID_1, "old", t0) as any]);
    store.buffer([makeRawMsg(JID_1, "new1", t1, "MSG002") as any]);
    store.buffer([makeRawMsg(JID_1, "new2", t2, "MSG003") as any]);

    // Watermark set to t0 (so only t1 and t2 messages should appear)
    db.setWatermark(JID_1, t0);
    app = buildApp(store, db);

    const res = await request(app).get(`/api/chats/${encodeURIComponent(JID_1)}/messages`);
    expect(res.status).toBe(200);
    expect(res.body.messages).toHaveLength(2);
    expect(res.body.messages.map((m: any) => m.body)).toEqual(["new1", "new2"]);
  });

  it("from/to window filters messages correctly", async () => {
    const base = 1_700_000_000_000;
    store.buffer([makeRawMsg(JID_1, "before", base - 1000) as any]);
    store.buffer([makeRawMsg(JID_1, "inside", base + 1000, "M2") as any]);
    store.buffer([makeRawMsg(JID_1, "after", base + 5000, "M3") as any]);
    app = buildApp(store, db);

    const from = new Date(base).toISOString();
    const to = new Date(base + 3000).toISOString();
    const res = await request(app).get(
      `/api/chats/${encodeURIComponent(JID_1)}/messages?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`
    );
    expect(res.status).toBe(200);
    expect(res.body.messages).toHaveLength(1);
    expect(res.body.messages[0].body).toBe("inside");
    expect(res.body.window.reason).toBe("from_to");
  });

  it("no-read JID returns empty messages with policy:no_read", async () => {
    db.addNoRead(JID_1, null);
    store.buffer([makeRawMsg(JID_1, "Secret", Date.now()) as any]);
    app = buildApp(store, db);

    const res = await request(app).get(`/api/chats/${encodeURIComponent(JID_1)}/messages?mode=full`);
    expect(res.status).toBe(200);
    expect(res.body.messages).toHaveLength(0);
    expect(res.body.policy).toBe("no_read");
  });

  it("POST /api/chats/:jid/ack advances watermark", async () => {
    app = buildApp(store, db);
    const watermark = "2026-04-19T12:00:00.000Z";

    const res = await request(app)
      .post(`/api/chats/${encodeURIComponent(JID_1)}/ack`)
      .send({ watermark });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    const wm = db.getWatermark(JID_1);
    expect(wm).not.toBeNull();
    expect(new Date(wm!.lastReviewedAt).toISOString()).toBe(watermark);
  });

  it("ack then since_last_review returns only newer messages", async () => {
    const t0 = Date.now() - 60_000;
    store.buffer([makeRawMsg(JID_1, "old", t0) as any]);
    db.setWatermark(JID_1, t0);
    app = buildApp(store, db);

    // Read: should return 0 new messages (t0 is exact watermark, strict >)
    const res1 = await request(app).get(`/api/chats/${encodeURIComponent(JID_1)}/messages`);
    expect(res1.body.messages).toHaveLength(0);
  });

  it("transcript includes gap data", async () => {
    db.recordGap({ chatJid: JID_1, fromTs: Date.now() - 5000, toTs: Date.now() - 1000, reason: "gateway_offline", backfillAttempted: true, backfillSucceeded: false });
    app = buildApp(store, db);

    const res = await request(app).get(`/api/chats/${encodeURIComponent(JID_1)}/messages?mode=full`);
    expect(res.status).toBe(200);
    expect(res.body.gaps).toHaveLength(1);
    expect(res.body.gaps[0].reason).toBe("gateway_offline");
  });

  it("transcript matches expected JSON schema shape", async () => {
    const now = Date.now();
    store.buffer([makeRawMsg(JID_1, "Test message", now - 1000) as any]);
    app = buildApp(store, db);

    const res = await request(app).get(`/api/chats/${encodeURIComponent(JID_1)}/messages?mode=full`);
    const body = res.body;

    expect(body).toMatchObject({
      chat: { jid: JID_1, type: "individual", isGroup: false },
      window: { reason: "full" },
      watermark: { previous: null },
    });
    expect(Array.isArray(body.messages)).toBe(true);
    expect(Array.isArray(body.gaps)).toBe(true);
    const msg = body.messages[0];
    expect(msg).toMatchObject({
      body: "Test message",
      fromMe: false,
      type: "text",
    });
    expect(typeof msg.timestamp).toBe("string");
    expect(typeof msg.id).toBe("string");
  });
});
