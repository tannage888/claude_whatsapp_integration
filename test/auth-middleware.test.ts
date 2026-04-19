import { describe, it, expect } from "vitest";
import express from "express";
import request from "supertest";
import { createBearerAuthMiddleware } from "../src/utils/auth-middleware.js";

function buildApp(token: string | null) {
  const app = express();
  app.use(createBearerAuthMiddleware(token));
  app.get("/protected", (_req, res) => res.json({ ok: true }));
  return app;
}

describe("Phase 11: Bearer auth middleware", () => {
  it("allows all requests when no token configured", async () => {
    const app = buildApp(null);
    const res = await request(app).get("/protected");
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it("rejects request with missing Authorization header when token configured", async () => {
    const app = buildApp("secret-token");
    const res = await request(app).get("/protected");
    expect(res.status).toBe(401);
    expect(res.body.error).toBe("unauthorized");
  });

  it("rejects request with invalid token", async () => {
    const app = buildApp("secret-token");
    const res = await request(app).get("/protected").set("Authorization", "Bearer wrong-token");
    expect(res.status).toBe(401);
  });

  it("allows request with valid Bearer token", async () => {
    const app = buildApp("secret-token");
    const res = await request(app).get("/protected").set("Authorization", "Bearer secret-token");
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it("rejects malformed Authorization header (not Bearer scheme)", async () => {
    const app = buildApp("secret-token");
    const res = await request(app).get("/protected").set("Authorization", "Basic secret-token");
    expect(res.status).toBe(401);
  });
});
