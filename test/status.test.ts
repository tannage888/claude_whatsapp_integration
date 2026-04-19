import { describe, it, expect } from "vitest";
import express from "express";
import request from "supertest";
import { createApiRouter } from "../src/routes/api.js";

describe("GET /api/status", () => {
  it("returns 200 with the expected shape", async () => {
    const startedAt = Date.now() - 5000;
    const app = express();
    app.use("/api", createApiRouter({
      startedAt,
      version: "0.1.0-test",
      getConnectionStatus: () => "disconnected",
    }));

    const res = await request(app).get("/api/status");

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      status: "ok",
      connection: "disconnected",
      version: "0.1.0-test",
    });
    expect(res.body.uptimeSeconds).toBeGreaterThanOrEqual(5);
    expect(typeof res.body.startedAt).toBe("string");
  });
});
