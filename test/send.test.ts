import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
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

function buildApp(sendMessageMock: ReturnType<typeof vi.fn>) {
  const fakeSocket = { sendMessage: sendMessageMock } as unknown as WASocket;
  const fakeWa = {
    store: { get: () => [], getStats: () => [] },
    getStatus: () => "connected",
    getQr: () => null,
    getPairingCode: () => null,
    wipeAuthState: () => {},
    getSocket: () => fakeSocket,
  } as unknown as WhatsAppConnection;

  const app = express();
  app.use(express.json());
  app.use("/api", createApiRouter({
    startedAt: Date.now(),
    version: "test",
    getConnectionStatus: () => "connected",
    whatsapp: fakeWa,
    authStatePath: "/tmp/auth",
  }));
  return app;
}

describe("Phase 6: Send", () => {
  let sendMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    sendMock = vi.fn().mockResolvedValue({ key: { id: "MSG-SENT-001" } });
  });

  it("single send returns messageId with status sent", async () => {
    const app = buildApp(sendMock);
    const res = await request(app)
      .post("/api/send")
      .send({ messages: [{ to: "+447700900123", text: "Hello" }] });

    expect(res.status).toBe(200);
    expect(res.body.results).toHaveLength(1);
    expect(res.body.results[0].status).toBe("sent");
    expect(res.body.results[0].messageId).toBe("MSG-SENT-001");
    expect(res.body.results[0].to).toBe("+447700900123");
  });

  it("bulk send returns array preserving order", async () => {
    sendMock
      .mockResolvedValueOnce({ key: { id: "ID-1" } })
      .mockResolvedValueOnce({ key: { id: "ID-2" } });

    const app = buildApp(sendMock);
    const res = await request(app)
      .post("/api/send")
      .send({
        messages: [
          { to: "+447700900123", text: "First" },
          { to: "+447700900124", text: "Second" },
        ],
      });

    expect(res.status).toBe(200);
    expect(res.body.results).toHaveLength(2);
    expect(res.body.results[0].messageId).toBe("ID-1");
    expect(res.body.results[1].messageId).toBe("ID-2");
  });

  it("group JID returns unsupported_recipient_type", async () => {
    const app = buildApp(sendMock);
    const res = await request(app)
      .post("/api/send")
      .send({ messages: [{ to: "12345678901-1234567890@g.us", text: "Hi group" }] });

    expect(res.status).toBe(200);
    expect(res.body.results[0].status).toBe("failed");
    expect(res.body.results[0].error).toBe("unsupported_recipient_type");
  });

  it("invalid E164 returns invalid_recipient", async () => {
    const app = buildApp(sendMock);
    const res = await request(app)
      .post("/api/send")
      .send({ messages: [{ to: "not-a-number", text: "Hi" }] });

    expect(res.status).toBe(200);
    expect(res.body.results[0].status).toBe("failed");
    expect(res.body.results[0].error).toBe("invalid_recipient");
  });

  it("dryRun=true returns dry_run status without calling sendMessage", async () => {
    const app = buildApp(sendMock);
    const res = await request(app)
      .post("/api/send")
      .send({ messages: [{ to: "+447700900123", text: "Dry run", dryRun: true }] });

    expect(res.status).toBe(200);
    expect(res.body.results[0].status).toBe("dry_run");
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("invalid body returns 400", async () => {
    const app = buildApp(sendMock);
    const res = await request(app).post("/api/send").send({ messages: [] });
    expect(res.status).toBe(400);
  });
});
