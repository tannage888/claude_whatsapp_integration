import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import express from "express";
import request from "supertest";
import { StateDb } from "../src/services/state-db.js";
import { MessageStore } from "../src/services/message-store.js";
import { MembershipService } from "../src/services/membership.js";
import { createApiRouter } from "../src/routes/api.js";
import type { WhatsAppConnection } from "../src/services/whatsapp.js";
import type { WASocket } from "@whiskeysockets/baileys";

const mockSocketEv = new EventEmitter();
const mockSocket = {
  ev: mockSocketEv,
  end: vi.fn(),
  groupFetchAllParticipating: vi.fn(),
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

const PARTICIPANT_JID = "447700900123@s.whatsapp.net";
const GROUP_JID = "12345678901-1234567890@g.us";

function buildApp(db: StateDb, store: MessageStore, ms: MembershipService) {
  const fakeWa = { store, getStatus: () => "connected", getQr: () => null, getPairingCode: () => null, wipeAuthState: () => {}, getSocket: () => mockSocket } as unknown as WhatsAppConnection;
  const app = express();
  app.use(express.json());
  app.use("/api", createApiRouter({
    startedAt: Date.now(),
    version: "test",
    getConnectionStatus: () => "connected",
    whatsapp: fakeWa,
    db,
    membership: ms,
    authStatePath: "/tmp/auth",
  }));
  return app;
}

describe("Phase 7: Membership", () => {
  let db: StateDb;
  let store: MessageStore;
  let ms: MembershipService;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "wa-ms-test-"));
    db = new StateDb(":memory:");
    store = new MessageStore(path.join(tmpDir, "store.json"));
    ms = new MembershipService(db, () => mockSocket as unknown as WASocket);
    mockSocketEv.removeAllListeners();
    vi.clearAllMocks();
  });

  afterEach(() => {
    db.close();
    if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("recordMember adds member to DB", () => {
    ms.recordMember(GROUP_JID, PARTICIPANT_JID, "Alice");
    const chats = db.findChatsForParticipant(PARTICIPANT_JID);
    expect(chats).toHaveLength(1);
    expect(chats[0].chatJid).toBe(GROUP_JID);
    expect(chats[0].displayName).toBe("Alice");
  });

  it("group message updates membership table via WhatsAppConnection", async () => {
    const { WhatsAppConnection } = await import("../src/services/whatsapp.js");
    const wa = new WhatsAppConnection(path.join(tmpDir, "store.json"));
    const membership = new MembershipService(db, () => wa.getSocket());

    wa.on("message:received", (msg: any) => {
      if (msg.remoteJid?.endsWith("@g.us") && msg.participantJid) {
        membership.recordMember(msg.remoteJid, msg.participantJid, null);
      }
    });

    const connectPromise = wa.connect();
    await new Promise<void>((resolve) => setImmediate(resolve));

    mockSocketEv.emit("messages.upsert", {
      messages: [{
        key: { remoteJid: GROUP_JID, fromMe: false, id: "GM001", participant: PARTICIPANT_JID },
        message: { conversation: "Hello group" },
        messageTimestamp: Math.floor(Date.now() / 1000),
      }],
      type: "notify",
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 20));

    const chats = db.findChatsForParticipant(PARTICIPANT_JID);
    expect(chats).toHaveLength(1);
    expect(chats[0].chatJid).toBe(GROUP_JID);

    await wa.disconnect();
    connectPromise.catch(() => {});
  });

  it("refresh repopulates from mocked groupFetchAllParticipating", async () => {
    mockSocket.groupFetchAllParticipating.mockResolvedValue({
      [GROUP_JID]: {
        subject: "Test Group",
        participants: [
          { id: PARTICIPANT_JID },
          { id: "447700900124@s.whatsapp.net" },
        ],
      },
    });

    const result = await ms.refresh();
    expect(result.groupsRefreshed).toBe(1);
    expect(result.membersUpdated).toBe(2);

    const chats = db.findChatsForParticipant(PARTICIPANT_JID);
    expect(chats).toHaveLength(1);
    expect(chats[0].chatJid).toBe(GROUP_JID);
  });

  it("getChatsForContact returns chats with lastVerifiedAt", () => {
    ms.recordMember(GROUP_JID, PARTICIPANT_JID, "Alice");
    const result = ms.getChatsForContact("+447700900123");
    expect(result.participantJid).toBe(PARTICIPANT_JID);
    expect(result.chats).toHaveLength(1);
    expect(result.chats[0].chatJid).toBe(GROUP_JID);
    expect(typeof result.chats[0].lastVerifiedAt).toBe("string");
  });

  describe("REST endpoints", () => {
    it("GET /api/contacts/:identifier/chats returns membership data", async () => {
      ms.recordMember(GROUP_JID, PARTICIPANT_JID, "Alice");
      const app = buildApp(db, store, ms);

      const res = await request(app).get(`/api/contacts/${encodeURIComponent("+447700900123")}/chats`);
      expect(res.status).toBe(200);
      expect(res.body.participantJid).toBe(PARTICIPANT_JID);
      expect(res.body.chats).toHaveLength(1);
    });

    it("POST /api/contacts/refresh calls groupFetchAllParticipating", async () => {
      mockSocket.groupFetchAllParticipating.mockResolvedValue({});
      const app = buildApp(db, store, ms);

      const res = await request(app).post("/api/contacts/refresh");
      expect(res.status).toBe(200);
      expect(mockSocket.groupFetchAllParticipating).toHaveBeenCalled();
    });
  });
});
