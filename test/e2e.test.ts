/**
 * Phase 12: End-to-end smoke test
 *
 * Spins up the daemon against mocked Baileys and exercises every major feature.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as http from "node:http";
import express from "express";
import request from "supertest";

// ── Baileys mock ───────────────────────────────────────────────────────────────

const mockSocketEv = new EventEmitter();
const mockSendMessage = vi.fn().mockResolvedValue({ key: { id: "SENT-E2E-001" } });
const mockSocket = {
  ev: mockSocketEv,
  end: vi.fn(),
  requestPairingCode: vi.fn(),
  sendMessage: mockSendMessage,
  groupFetchAllParticipating: vi.fn().mockResolvedValue({}),
};

vi.mock("@whiskeysockets/baileys", () => ({
  default: vi.fn(() => mockSocket),
  useMultiFileAuthState: vi.fn().mockResolvedValue({
    state: { creds: { registered: false }, keys: {} },
    saveCreds: vi.fn(),
  }),
  fetchLatestBaileysVersion: vi.fn().mockResolvedValue({ version: [2, 3000, 0] }),
  makeCacheableSignalKeyStore: vi.fn((keys: unknown) => keys),
  DisconnectReason: { loggedOut: 401 },
}));

// ── Imports (after mock setup) ─────────────────────────────────────────────────

import { WhatsAppConnection } from "../src/services/whatsapp.js";
import { StateDb } from "../src/services/state-db.js";
import { NoReadService } from "../src/services/no-read.js";
import { MembershipService } from "../src/services/membership.js";
import { GapDetector } from "../src/services/gap-detector.js";
import { createApiRouter } from "../src/routes/api.js";
import { createBearerAuthMiddleware } from "../src/utils/auth-middleware.js";

const JID_1 = "447700900123@s.whatsapp.net";
const JID_GROUP = "12345678901-1234567890@g.us";
const PARTICIPANT = "447700900456@s.whatsapp.net";

function makeMsg(jid: string, body: string, id = "MSG001", participant?: string) {
  return {
    key: { remoteJid: jid, fromMe: false, id, participant: participant ?? undefined },
    message: { conversation: body },
    messageTimestamp: Math.floor(Date.now() / 1000),
  };
}

describe("Phase 12: End-to-end smoke test", () => {
  let tmpDir: string;
  let wa: WhatsAppConnection;
  let db: StateDb;
  let noRead: NoReadService;
  let membership: MembershipService;
  let app: express.Express;
  let connectPromise: Promise<void>;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "wa-e2e-test-"));
    mockSocketEv.removeAllListeners();
    vi.clearAllMocks();
    mockSendMessage.mockResolvedValue({ key: { id: "SENT-E2E-001" } });
    mockSocket.groupFetchAllParticipating.mockResolvedValue({});

    wa = new WhatsAppConnection(path.join(tmpDir, "store.json"));
    db = new StateDb(path.join(tmpDir, "state.db"));
    noRead = new NoReadService(db, wa.store);
    membership = new MembershipService(db, () => wa.getSocket() as any);

    // Wire no-read filter on message events
    wa.on("message:received", (msg: any) => {
      if (noRead.isBlocked(msg.remoteJid)) {
        wa.store.purge(msg.remoteJid);
        return;
      }
      if (msg.remoteJid.endsWith("@g.us") && msg.participantJid) {
        membership.recordMember(msg.remoteJid, msg.participantJid, null);
      }
    });

    app = express();
    app.use(express.json());
    app.use(createBearerAuthMiddleware(null)); // no auth for e2e
    app.use("/api", createApiRouter({
      startedAt: Date.now(),
      version: "0.1.0-e2e",
      getConnectionStatus: () => wa.getStatus(),
      whatsapp: wa,
      db,
      noRead,
      membership,
      authStatePath: path.join(tmpDir, "auth_state"),
    }));

    connectPromise = wa.connect();
    await new Promise<void>((resolve) => setImmediate(resolve));
  });

  afterEach(async () => {
    await wa.disconnect();
    connectPromise.catch(() => {});
    db.close();
    if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("1. simulates inbound 1:1 message and reads via /api/chats/:jid/messages", async () => {
    mockSocketEv.emit("messages.upsert", {
      messages: [makeMsg(JID_1, "Hello from Alice")],
      type: "notify",
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 20));

    const res = await request(app).get(`/api/chats/${encodeURIComponent(JID_1)}/messages?mode=full`);
    expect(res.status).toBe(200);
    expect(res.body.messages).toHaveLength(1);
    expect(res.body.messages[0].body).toBe("Hello from Alice");
    expect(res.body.chat.jid).toBe(JID_1);
    expect(res.body.chat.type).toBe("individual");
  });

  it("2. simulates group message and reads it", async () => {
    mockSocketEv.emit("messages.upsert", {
      messages: [makeMsg(JID_GROUP, "Group message", "GMSG001", PARTICIPANT)],
      type: "notify",
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 20));

    const res = await request(app).get(`/api/chats/${encodeURIComponent(JID_GROUP)}/messages?mode=full`);
    expect(res.status).toBe(200);
    expect(res.body.messages).toHaveLength(1);
    expect(res.body.messages[0].body).toBe("Group message");
    expect(res.body.chat.type).toBe("group");
    expect(res.body.chat.isGroup).toBe(true);
  });

  it("3. acks watermark and subsequent read returns only new messages", async () => {
    // old msg: 2 min ago, watermark: 1 min ago, new msg: 30 sec ago
    const now = Date.now();
    const oldTs = Math.floor((now - 120_000) / 1000);
    const newTs = Math.floor((now - 30_000) / 1000);
    const T = now - 60_000;

    // Add old message (before watermark)
    mockSocketEv.emit("messages.upsert", {
      messages: [{ key: { remoteJid: JID_1, fromMe: false, id: "OLD001" }, message: { conversation: "Old message" }, messageTimestamp: oldTs }],
      type: "notify",
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 20));

    // Ack at T
    const watermark = new Date(T).toISOString();
    await request(app)
      .post(`/api/chats/${encodeURIComponent(JID_1)}/ack`)
      .send({ watermark });

    // Add new message (after watermark)
    mockSocketEv.emit("messages.upsert", {
      messages: [{ key: { remoteJid: JID_1, fromMe: false, id: "NEW001" }, message: { conversation: "New message after ack" }, messageTimestamp: newTs }],
      type: "notify",
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 20));

    const res = await request(app).get(`/api/chats/${encodeURIComponent(JID_1)}/messages`);
    expect(res.status).toBe(200);
    const bodies = res.body.messages.map((m: any) => m.body);
    expect(bodies).toContain("New message after ack");
    expect(bodies).not.toContain("Old message");
  });

  it("4. adds JID to no-read, simulates message, asserts dropped", async () => {
    // Add JID to no-read
    await request(app).post("/api/no-read").send({ identifier: JID_1 });

    // Simulate incoming message
    mockSocketEv.emit("messages.upsert", {
      messages: [makeMsg(JID_1, "Secret message")],
      type: "notify",
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 20));

    // Should not appear in store
    const stored = wa.store.get(JID_1);
    expect(stored).toHaveLength(0);

    // Transcript should show policy:no_read
    const res = await request(app).get(`/api/chats/${encodeURIComponent(JID_1)}/messages?mode=full`);
    expect(res.body.policy).toBe("no_read");
    expect(res.body.messages).toHaveLength(0);
  });

  it("5. sends a message and asserts socket called with correct args", async () => {
    const res = await request(app).post("/api/send").send({
      messages: [{ to: "+447700900123", text: "Hello from daemon" }],
    });
    expect(res.status).toBe(200);
    expect(res.body.results[0].status).toBe("sent");
    expect(res.body.results[0].messageId).toBe("SENT-E2E-001");
    expect(mockSendMessage).toHaveBeenCalledWith(JID_1, { text: "Hello from daemon" });
  });

  it("6. imports phone-export fixture and asserts gap resolved", async () => {
    // Create an open gap
    const gapFrom = new Date("2026-04-12T00:00:00Z").getTime();
    const gapTo = new Date("2026-04-14T23:59:59Z").getTime();
    const gapId = db.recordGap({ chatJid: JID_1, fromTs: gapFrom, toTs: gapTo, reason: "gateway_offline", backfillAttempted: true, backfillSucceeded: false });

    const fixtureContent = fs.readFileSync(
      path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/, "$1")), "fixtures", "export_chat_alice.txt")
    );

    const res = await request(app)
      .post("/api/import/phone-export")
      .query({ jid: JID_1 })
      .attach("file", fixtureContent, { filename: "chat.txt", contentType: "text/plain" });

    expect(res.status).toBe(200);
    expect(res.body.imported).toBeGreaterThan(0);
    expect(res.body.gapsResolved).toContain(gapId);
    expect(db.getGap(gapId)!.resolvedAt).not.toBeNull();
  });

  it("7. transcript response matches expected JSON schema", async () => {
    mockSocketEv.emit("messages.upsert", {
      messages: [makeMsg(JID_1, "Schema test message")],
      type: "notify",
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 20));

    const res = await request(app).get(`/api/chats/${encodeURIComponent(JID_1)}/messages?mode=full`);
    const body = res.body;

    // Verify top-level schema
    expect(body).toHaveProperty("chat");
    expect(body).toHaveProperty("window");
    expect(body).toHaveProperty("messages");
    expect(body).toHaveProperty("gaps");
    expect(body).toHaveProperty("watermark");

    // Chat shape
    expect(body.chat).toMatchObject({ jid: JID_1, type: "individual", isGroup: false });

    // Window shape
    expect(body.window).toHaveProperty("to");
    expect(body.window).toHaveProperty("reason");

    // Message shape
    const msg = body.messages[0];
    expect(msg).toHaveProperty("id");
    expect(msg).toHaveProperty("timestamp");
    expect(msg).toHaveProperty("fromMe");
    expect(msg).toHaveProperty("sender");
    expect(msg).toHaveProperty("type");
    expect(msg).toHaveProperty("body");
    expect(msg).toHaveProperty("quotedMessageId");

    // Watermark shape
    expect(body.watermark).toHaveProperty("previous");
    expect(body.watermark).toHaveProperty("new");
  });
});
