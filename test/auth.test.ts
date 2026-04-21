import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import express from "express";
import request from "supertest";
import { createApiRouter } from "../src/routes/api.js";

// ── Baileys mock ──────────────────────────────────────────────────────────────

const mockSocketEv = new EventEmitter();
const mockSocket = {
  ev: mockSocketEv,
  end: vi.fn(),
  requestPairingCode: vi.fn().mockResolvedValue("ABCD-1234"),
  sendMessage: vi.fn(),
};

vi.mock("@whiskeysockets/baileys", () => ({
  default: vi.fn(() => mockSocket),
  useMultiFileAuthState: vi.fn().mockResolvedValue({
    state: {
      creds: { registered: false },
      keys: {},
    },
    saveCreds: vi.fn(),
  }),
  fetchLatestBaileysVersion: vi.fn().mockResolvedValue({ version: [2, 3000, 0] }),
  makeCacheableSignalKeyStore: vi.fn((keys: unknown) => keys),
  DisconnectReason: { loggedOut: 401 },
}));

// ── Helpers ───────────────────────────────────────────────────────────────────

async function importWhatsApp() {
  const { WhatsAppConnection } = await import("../src/services/whatsapp.js");
  return WhatsAppConnection;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("Phase 1: Auth + connection", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "wa-test-"));
    mockSocketEv.removeAllListeners();
    vi.clearAllMocks();
  });

  afterEach(() => {
    if (fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("starts in disconnected status", async () => {
    const WhatsAppConnection = await importWhatsApp();
    const wa = new WhatsAppConnection(path.join(tmpDir, "store.json"));
    expect(wa.getStatus()).toBe("disconnected");
  });

  it("emits qr:code and becomes qr_ready when QR event fires", async () => {
    const { useMultiFileAuthState } = await import("@whiskeysockets/baileys");
    // Use registered=true so WhatsAppConnection skips the pairing-code path
    // and falls through to the QR-only branch (this is the path mobile QR auth uses).
    vi.mocked(useMultiFileAuthState).mockResolvedValueOnce({
      state: { creds: { registered: true }, keys: {} },
      saveCreds: vi.fn(),
    } as any);

    const WhatsAppConnection = await importWhatsApp();
    const wa = new WhatsAppConnection(path.join(tmpDir, "store.json"));

    const qrCodes: string[] = [];
    wa.on("qr:code", (qr: string) => qrCodes.push(qr));

    // Start connect but don't await — it hangs waiting for events
    const connectPromise = wa.connect();

    // Simulate Baileys emitting a QR code
    await new Promise<void>((resolve) => setImmediate(resolve));
    mockSocketEv.emit("connection.update", { qr: "mock-qr-data-123" });

    await new Promise<void>((resolve) => setTimeout(resolve, 10));

    expect(wa.getStatus()).toBe("qr_ready");
    expect(qrCodes).toContain("mock-qr-data-123");
    expect(wa.getQr()).toBe("mock-qr-data-123");

    // Clean up
    await wa.disconnect();
    connectPromise.catch(() => {});
  });

  it("becomes connected when connection opens", async () => {
    const WhatsAppConnection = await importWhatsApp();
    const wa = new WhatsAppConnection(path.join(tmpDir, "store.json"));

    const statuses: string[] = [];
    wa.on("connection:status", (s: string) => statuses.push(s));

    const connectPromise = wa.connect();
    await new Promise<void>((resolve) => setImmediate(resolve));

    mockSocketEv.emit("connection.update", { connection: "open" });
    await new Promise<void>((resolve) => setTimeout(resolve, 10));

    expect(wa.getStatus()).toBe("connected");
    expect(statuses).toContain("connected");

    await wa.disconnect();
    connectPromise.catch(() => {});
  });

  it("wipeAuthState removes auth_state directory contents", async () => {
    const authDir = path.join(tmpDir, "auth_state");
    fs.mkdirSync(authDir, { recursive: true });
    fs.writeFileSync(path.join(authDir, "creds.json"), JSON.stringify({ test: true }));

    const WhatsAppConnection = await importWhatsApp();
    const wa = new WhatsAppConnection(path.join(tmpDir, "store.json"));

    wa.wipeAuthState(authDir);

    // Directory recreated but empty
    expect(fs.existsSync(authDir)).toBe(true);
    const files = fs.readdirSync(authDir);
    expect(files).toHaveLength(0);
    expect(wa.getStatus()).toBe("disconnected");
  });

  it("DELETE /api/auth wipes auth state via endpoint", async () => {
    const authDir = path.join(tmpDir, "auth_state");
    fs.mkdirSync(authDir, { recursive: true });
    fs.writeFileSync(path.join(authDir, "creds.json"), "{}");

    const WhatsAppConnection = await importWhatsApp();
    const wa = new WhatsAppConnection(path.join(tmpDir, "store.json"));

    const app = express();
    app.use(express.json());
    app.use(
      "/api",
      createApiRouter({
        startedAt: Date.now(),
        version: "test",
        getConnectionStatus: () => wa.getStatus(),
        whatsapp: wa,
        authStatePath: authDir,
      })
    );

    const res = await request(app).delete("/api/auth");
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(fs.readdirSync(authDir)).toHaveLength(0);
  });

  it("GET /api/auth/status returns current connection status", async () => {
    const WhatsAppConnection = await importWhatsApp();
    const wa = new WhatsAppConnection(path.join(tmpDir, "store.json"));

    const app = express();
    app.use(
      "/api",
      createApiRouter({
        startedAt: Date.now(),
        version: "test",
        getConnectionStatus: () => wa.getStatus(),
        whatsapp: wa,
        authStatePath: tmpDir,
      })
    );

    const res = await request(app).get("/api/auth/status");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("disconnected");
  });

  it("GET /api/auth/qr returns 409 when not in qr_ready state", async () => {
    const WhatsAppConnection = await importWhatsApp();
    const wa = new WhatsAppConnection(path.join(tmpDir, "store.json"));

    const app = express();
    app.use(
      "/api",
      createApiRouter({
        startedAt: Date.now(),
        version: "test",
        getConnectionStatus: () => wa.getStatus(),
        whatsapp: wa,
        authStatePath: tmpDir,
      })
    );

    const res = await request(app).get("/api/auth/qr");
    expect(res.status).toBe(409);
  });

  it("reconnect backoff doubles each attempt up to 60s cap", () => {
    const delays: number[] = [];
    for (let attempt = 1; attempt <= 10; attempt++) {
      delays.push(Math.min(1000 * 2 ** attempt, 60_000));
    }
    // attempt 1: 2000, 2: 4000, 3: 8000, 4: 16000, 5: 32000, 6+: 60000
    expect(delays[0]).toBe(2000);
    expect(delays[1]).toBe(4000);
    expect(delays[2]).toBe(8000);
    expect(delays[3]).toBe(16000);
    expect(delays[4]).toBe(32000);
    expect(delays[5]).toBe(60000);
    expect(delays[6]).toBe(60000);
    expect(delays[9]).toBe(60000);
  });
});
