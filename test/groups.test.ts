import { describe, it, expect } from "vitest";
import express from "express";
import request from "supertest";
import { createApiRouter } from "../src/routes/api.js";
import type { WhatsAppConnection } from "../src/services/whatsapp.js";

function makeApp(socketOverride?: object) {
  const app = express();
  app.use(express.json());

  const whatsapp = {
    getStatus: () => "connected",
    getQr: () => null,
    getPairingCode: () => null,
    getSocket: () => socketOverride ?? null,
    store: {} as WhatsAppConnection["store"],
    wipeAuthState: () => {},
  } as unknown as WhatsAppConnection;

  app.use(
    "/api",
    createApiRouter({
      startedAt: Date.now(),
      version: "0.0.0-test",
      getConnectionStatus: () => "connected",
      whatsapp,
    }),
  );
  return app;
}

describe("GET /api/groups", () => {
  it("returns 503 when whatsapp not initialised", async () => {
    const app = express();
    app.use(express.json());
    app.use(
      "/api",
      createApiRouter({
        startedAt: Date.now(),
        version: "0.0.0-test",
        getConnectionStatus: () => "disconnected",
      }),
    );
    const res = await request(app).get("/api/groups");
    expect(res.status).toBe(503);
    expect(res.body.error).toBe("whatsapp_not_initialised");
  });

  it("returns 503 when socket not ready", async () => {
    const app = makeApp(null as unknown as object);
    const res = await request(app).get("/api/groups");
    expect(res.status).toBe(503);
    expect(res.body.error).toBe("socket_not_ready");
  });

  it("returns groups with participants in E164 format", async () => {
    const mockGroups = {
      "123456789-1234567@g.us": {
        id: "123456789-1234567@g.us",
        subject: "Test Group",
        participants: [
          { id: "447700900123@s.whatsapp.net" },
          { id: "14155551234@s.whatsapp.net" },
          { id: "somethingelse@lid" },
        ],
      },
      "987654321-9876543@g.us": {
        id: "987654321-9876543@g.us",
        subject: "Another Group",
        participants: [],
      },
    };

    const sock = { groupFetchAllParticipating: async () => mockGroups };
    const app = makeApp(sock);

    const res = await request(app).get("/api/groups");
    expect(res.status).toBe(200);
    expect(res.body.groups).toHaveLength(2);

    const testGroup = res.body.groups.find((g: { jid: string }) => g.jid === "123456789-1234567@g.us");
    expect(testGroup).toBeDefined();
    expect(testGroup.name).toBe("Test Group");
    expect(testGroup.participants).toEqual(["+447700900123", "+14155551234"]);

    const anotherGroup = res.body.groups.find((g: { jid: string }) => g.jid === "987654321-9876543@g.us");
    expect(anotherGroup.name).toBe("Another Group");
    expect(anotherGroup.participants).toEqual([]);
  });

  it("filters out non-phone JIDs (lids, groups)", async () => {
    const mockGroups = {
      "111@g.us": {
        id: "111@g.us",
        subject: "Mixed",
        participants: [
          { id: "441234567890@s.whatsapp.net" },
          { id: "12345@lid" },
          { id: "99999@g.us" },
        ],
      },
    };

    const sock = { groupFetchAllParticipating: async () => mockGroups };
    const app = makeApp(sock);

    const res = await request(app).get("/api/groups");
    expect(res.status).toBe(200);
    expect(res.body.groups[0].participants).toEqual(["+441234567890"]);
  });
});
