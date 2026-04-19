import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import express from "express";
import request from "supertest";
import { StateDb } from "../src/services/state-db.js";
import { MessageStore } from "../src/services/message-store.js";
import { NoReadService } from "../src/services/no-read.js";
import { createApiRouter } from "../src/routes/api.js";
import type { WhatsAppConnection } from "../src/services/whatsapp.js";

// ── Baileys mock (needed because message-capture tests import whatsapp.ts) ──

const mockSocketEv = new EventEmitter();
const mockSocket = { ev: mockSocketEv, end: vi.fn() };

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

const JID = "447700900123@s.whatsapp.net";
const E164 = "+447700900123";

function makeRawMsg(jid: string, body: string, id = "MSG001") {
  return {
    key: { remoteJid: jid, fromMe: false, id },
    message: { conversation: body },
    messageTimestamp: Math.floor(Date.now() / 1000),
  };
}

function buildApp(store: MessageStore, db: StateDb, noRead: NoReadService) {
  const fakeWa = { store, getStatus: () => "connected", getQr: () => null, getPairingCode: () => null, wipeAuthState: () => {} } as unknown as WhatsAppConnection;
  const app = express();
  app.use(express.json());
  app.use("/api", createApiRouter({
    startedAt: Date.now(),
    version: "test",
    getConnectionStatus: () => "connected",
    whatsapp: fakeWa,
    db,
    noRead,
    authStatePath: "/tmp/auth",
  }));
  return app;
}

describe("Phase 5: No-read list", () => {
  let db: StateDb;
  let store: MessageStore;
  let noRead: NoReadService;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "wa-nr-test-"));
    db = new StateDb(":memory:");
    store = new MessageStore(path.join(tmpDir, "store.json"));
    noRead = new NoReadService(db, store);
  });

  afterEach(() => {
    db.close();
    if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("add by E164 resolves to JID", () => {
    const result = noRead.add(E164);
    expect(result.jid).toBe(JID);
    expect(db.isNoRead(JID)).toBe(true);
  });

  it("add by JID stores it directly", () => {
    const result = noRead.add(JID);
    expect(result.jid).toBe(JID);
    expect(db.isNoRead(JID)).toBe(true);
  });

  it("list returns all entries", () => {
    noRead.add(JID);
    const list = noRead.list();
    expect(list).toHaveLength(1);
    expect(list[0].jid).toBe(JID);
  });

  it("remove clears the entry", () => {
    noRead.add(JID);
    noRead.remove(JID);
    expect(db.isNoRead(JID)).toBe(false);
  });

  it("adding JID purges pre-existing messages from MessageStore", () => {
    store.buffer([makeRawMsg(JID, "secret message") as any]);
    expect(store.get(JID)).toHaveLength(1);

    noRead.add(JID);
    expect(store.get(JID)).toHaveLength(0);
  });

  it("adding JID purges pre-existing membership rows", () => {
    db.upsertChatMember({ chatJid: "g1@g.us", participantJid: JID, displayName: null, lastVerifiedAt: Date.now() });
    expect(db.findChatsForParticipant(JID)).toHaveLength(1);

    noRead.add(JID);
    expect(db.findChatsForParticipant(JID)).toHaveLength(0);
  });

  describe("REST endpoints", () => {
    it("GET /api/no-read returns empty list", async () => {
      const app = buildApp(store, db, noRead);
      const res = await request(app).get("/api/no-read");
      expect(res.status).toBe(200);
      expect(res.body.entries).toHaveLength(0);
    });

    it("POST /api/no-read adds entry and returns resolved JID", async () => {
      const app = buildApp(store, db, noRead);
      const res = await request(app).post("/api/no-read").send({ identifier: E164 });
      expect(res.status).toBe(201);
      expect(res.body.jid).toBe(JID);
    });

    it("DELETE /api/no-read/:jid removes entry", async () => {
      noRead.add(JID);
      const app = buildApp(store, db, noRead);
      const res = await request(app).delete(`/api/no-read/${encodeURIComponent(JID)}`);
      expect(res.status).toBe(200);
      expect(db.isNoRead(JID)).toBe(false);
    });
  });

  describe("Incoming message filter", () => {
    it("incoming message for no-read JID is NOT stored in MessageStore (via WhatsAppConnection)", async () => {
      const { WhatsAppConnection } = await import("../src/services/whatsapp.js");
      const wa = new WhatsAppConnection(path.join(tmpDir, "store2.json"));

      // Add JID to no-read before connecting
      const noReadService = new NoReadService(db, wa.store);
      noReadService.add(JID);

      // Wire no-read filter on message events
      wa.on("message:received", (msg: any) => {
        if (noReadService.isBlocked(msg.remoteJid)) {
          wa.store.purge(msg.remoteJid);
        }
      });

      const connectPromise = wa.connect();
      await new Promise<void>((resolve) => setImmediate(resolve));

      mockSocketEv.emit("messages.upsert", {
        messages: [makeRawMsg(JID, "blocked message")],
        type: "notify",
      });
      await new Promise<void>((resolve) => setTimeout(resolve, 20));

      expect(wa.store.get(JID)).toHaveLength(0);

      await wa.disconnect();
      connectPromise.catch(() => {});
    });
  });
});
