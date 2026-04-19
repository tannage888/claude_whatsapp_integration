import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { fileURLToPath } from "node:url";
import express from "express";
import request from "supertest";
import { StateDb } from "../src/services/state-db.js";
import { MessageStore } from "../src/services/message-store.js";
import { parsePhoneExport, importPhoneExport } from "../src/services/phone-export-importer.js";
import { createApiRouter } from "../src/routes/api.js";
import type { WhatsAppConnection } from "../src/services/whatsapp.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const FIXTURE_PATH = path.join(__dirname, "fixtures", "export_chat_alice.txt");
const JID = "447700900123@s.whatsapp.net";

function buildApp(store: MessageStore, db: StateDb) {
  const fakeWa = { store, getStatus: () => "connected", getQr: () => null, getPairingCode: () => null, wipeAuthState: () => {}, getSocket: () => null } as unknown as WhatsAppConnection;
  const app = express();
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

describe("Phase 9: Phone-export importer", () => {
  let db: StateDb;
  let store: MessageStore;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "wa-import-test-"));
    db = new StateDb(":memory:");
    store = new MessageStore(path.join(tmpDir, "store.json"));
  });

  afterEach(() => {
    db.close();
    if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("parsePhoneExport", () => {
    it("parses fixture file to expected message count", () => {
      const text = fs.readFileSync(FIXTURE_PATH, "utf-8");
      const messages = parsePhoneExport(text);
      expect(messages).toHaveLength(7);
    });

    it("parses message fields correctly", () => {
      const text = "[12/04/2026, 09:01:14] Alice Smith: Hello world";
      const messages = parsePhoneExport(text);
      expect(messages).toHaveLength(1);
      expect(messages[0].sender).toBe("Alice Smith");
      expect(messages[0].body).toBe("Hello world");
      expect(messages[0].timestamp).toBeGreaterThan(0);
    });

    it("handles multi-line messages", () => {
      const text = "[12/04/2026, 09:01:14] Alice: First line\nSecond line\n[12/04/2026, 09:02:00] Bob: Next msg";
      const messages = parsePhoneExport(text);
      expect(messages).toHaveLength(2);
      expect(messages[0].body).toBe("First line\nSecond line");
    });
  });

  describe("importPhoneExport", () => {
    it("imports all messages from fixture file", async () => {
      const text = fs.readFileSync(FIXTURE_PATH, "utf-8");
      const result = await importPhoneExport(text, JID, store, db);
      expect(result.imported).toBe(7);
      expect(result.duplicates).toBe(0);
    });

    it("re-import same file produces 100% duplicates", async () => {
      const text = fs.readFileSync(FIXTURE_PATH, "utf-8");
      await importPhoneExport(text, JID, store, db);
      const result2 = await importPhoneExport(text, JID, store, db);
      expect(result2.duplicates).toBe(7);
      expect(result2.imported).toBe(0);
    });

    it("import covering an open gap auto-resolves it", async () => {
      // Create a gap covering the fixture file's date range
      const gapFrom = new Date("2026-04-12T00:00:00Z").getTime();
      const gapTo = new Date("2026-04-14T23:59:59Z").getTime();
      const gapId = db.recordGap({
        chatJid: JID,
        fromTs: gapFrom,
        toTs: gapTo,
        reason: "gateway_offline",
        backfillAttempted: true,
        backfillSucceeded: false,
      });

      const text = fs.readFileSync(FIXTURE_PATH, "utf-8");
      const result = await importPhoneExport(text, JID, store, db);

      expect(result.gapsResolved).toContain(gapId);
      expect(db.getGap(gapId)!.resolvedAt).not.toBeNull();
    });
  });

  describe("REST endpoint", () => {
    it("POST /api/import/phone-export returns import stats", async () => {
      const app = buildApp(store, db);
      const fileContent = fs.readFileSync(FIXTURE_PATH);

      const res = await request(app)
        .post("/api/import/phone-export")
        .query({ jid: JID })
        .attach("file", fileContent, { filename: "chat.txt", contentType: "text/plain" });

      expect(res.status).toBe(200);
      expect(res.body.imported).toBe(7);
      expect(res.body.duplicates).toBe(0);
      expect(Array.isArray(res.body.gapsResolved)).toBe(true);
    });
  });
});
