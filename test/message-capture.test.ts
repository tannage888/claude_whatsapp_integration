import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// ── Baileys mock ──────────────────────────────────────────────────────────────

const mockSocketEv = new EventEmitter();
const mockSocket = {
  ev: mockSocketEv,
  end: vi.fn(),
  requestPairingCode: vi.fn(),
  sendMessage: vi.fn(),
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

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeMsg(overrides: Record<string, unknown> = {}) {
  return {
    key: {
      remoteJid: "447700900123@s.whatsapp.net",
      fromMe: false,
      id: "MSGID001",
      ...((overrides.key as object) ?? {}),
    },
    message: { conversation: "Hello world" },
    messageTimestamp: Math.floor(Date.now() / 1000),
    ...overrides,
  };
}

function makeGroupMsg(participantJid: string) {
  return {
    key: {
      remoteJid: "12345678901-1234567890@g.us",
      fromMe: false,
      id: "GROUPMSG001",
      participant: participantJid,
    },
    message: { conversation: "Group message content" },
    messageTimestamp: Math.floor(Date.now() / 1000),
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("Phase 2: Message capture + MessageStore", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "wa-msg-test-"));
    mockSocketEv.removeAllListeners();
    vi.clearAllMocks();
  });

  afterEach(() => {
    if (fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  describe("MessageStore", () => {
    it("buffers and retrieves a 1:1 message", async () => {
      const { MessageStore } = await import("../src/services/message-store.js");
      const store = new MessageStore(path.join(tmpDir, "store.json"));

      const msg = makeMsg();
      store.buffer([msg as any]);

      const msgs = store.get("447700900123@s.whatsapp.net");
      expect(msgs).toHaveLength(1);
      expect(msgs[0].key?.id).toBe("MSGID001");
    });

    it("buffers group messages (does not filter @g.us)", async () => {
      const { MessageStore } = await import("../src/services/message-store.js");
      const store = new MessageStore(path.join(tmpDir, "store.json"));

      const groupMsg = makeGroupMsg("447700900456@s.whatsapp.net");
      store.buffer([groupMsg as any]);

      const msgs = store.get("12345678901-1234567890@g.us");
      expect(msgs).toHaveLength(1);
    });

    it("persists to disk and reloads on restart", async () => {
      const { MessageStore } = await import("../src/services/message-store.js");
      const storePath = path.join(tmpDir, "store.json");

      const store1 = new MessageStore(storePath);
      store1.buffer([makeMsg() as any]);
      store1.save();

      const store2 = new MessageStore(storePath);
      store2.load();

      const msgs = store2.get("447700900123@s.whatsapp.net");
      expect(msgs).toHaveLength(1);
      expect(msgs[0].key?.id).toBe("MSGID001");
    });

    it("caps messages per JID at 500", async () => {
      const { MessageStore } = await import("../src/services/message-store.js");
      const store = new MessageStore(path.join(tmpDir, "store.json"));

      const msgs = Array.from({ length: 600 }, (_, i) =>
        makeMsg({ key: { remoteJid: "447700900123@s.whatsapp.net", id: `MSG${i}` } })
      );
      store.buffer(msgs as any);

      expect(store.get("447700900123@s.whatsapp.net")).toHaveLength(500);
    });
  });

  describe("WhatsAppConnection message events", () => {
    it("emits message:received when 1:1 notify message arrives", async () => {
      const { WhatsAppConnection } = await import("../src/services/whatsapp.js");
      const wa = new WhatsAppConnection(path.join(tmpDir, "store.json"));

      const received: unknown[] = [];
      wa.on("message:received", (m: unknown) => received.push(m));

      const connectPromise = wa.connect();
      await new Promise<void>((resolve) => setImmediate(resolve));

      mockSocketEv.emit("messages.upsert", {
        messages: [makeMsg()],
        type: "notify",
      });
      await new Promise<void>((resolve) => setTimeout(resolve, 10));

      expect(received).toHaveLength(1);
      expect((received[0] as any).remoteJid).toBe("447700900123@s.whatsapp.net");
      expect((received[0] as any).participantJid).toBeNull();

      await wa.disconnect();
      connectPromise.catch(() => {});
    });

    it("emits message:received with participantJid for group messages", async () => {
      const { WhatsAppConnection } = await import("../src/services/whatsapp.js");
      const wa = new WhatsAppConnection(path.join(tmpDir, "store.json"));

      const received: unknown[] = [];
      wa.on("message:received", (m: unknown) => received.push(m));

      const connectPromise = wa.connect();
      await new Promise<void>((resolve) => setImmediate(resolve));

      const groupMsg = makeGroupMsg("447700900456@s.whatsapp.net");
      mockSocketEv.emit("messages.upsert", {
        messages: [groupMsg],
        type: "notify",
      });
      await new Promise<void>((resolve) => setTimeout(resolve, 10));

      expect(received).toHaveLength(1);
      const m = received[0] as any;
      expect(m.remoteJid).toBe("12345678901-1234567890@g.us");
      expect(m.participantJid).toBe("447700900456@s.whatsapp.net");

      await wa.disconnect();
      connectPromise.catch(() => {});
    });

    it("stores messages in MessageStore on upsert", async () => {
      const { WhatsAppConnection } = await import("../src/services/whatsapp.js");
      const wa = new WhatsAppConnection(path.join(tmpDir, "store.json"));

      const connectPromise = wa.connect();
      await new Promise<void>((resolve) => setImmediate(resolve));

      mockSocketEv.emit("messages.upsert", {
        messages: [makeMsg()],
        type: "notify",
      });
      await new Promise<void>((resolve) => setTimeout(resolve, 10));

      const stored = wa.store.get("447700900123@s.whatsapp.net");
      expect(stored).toHaveLength(1);

      await wa.disconnect();
      connectPromise.catch(() => {});
    });
  });
});
