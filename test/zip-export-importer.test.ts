import { describe, it, expect, beforeEach, afterEach } from "vitest";
import AdmZip from "adm-zip";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import express from "express";
import request from "supertest";
import { StateDb } from "../src/services/state-db.js";
import { MessageStore } from "../src/services/message-store.js";
import {
  importZipExport,
  ZipImportError,
  isZipMimeType,
  isWhatsAppExportFilename,
} from "../src/services/zip-export-importer.js";
import { createApiRouter } from "../src/routes/api.js";
import type { WhatsAppConnection } from "../src/services/whatsapp.js";

const JID = "447700900123@s.whatsapp.net";

const SAMPLE_CHAT_TEXT = `[12/04/2026, 09:01:14] Alice Smith: Hello world
[12/04/2026, 09:02:00] Me: Hi Alice
[12/04/2026, 09:03:30] Alice Smith: This is a
multi-line message
[13/04/2026, 10:15:00] Alice Smith: see you soon`;

function makeZip(files: Record<string, Buffer | string>): Buffer {
  const zip = new AdmZip();
  for (const [name, content] of Object.entries(files)) {
    zip.addFile(name, typeof content === "string" ? Buffer.from(content, "utf-8") : content);
  }
  return zip.toBuffer();
}

describe("Phase 14: ZIP export importer", () => {
  let db: StateDb;
  let store: MessageStore;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "wa-zip-test-"));
    db = new StateDb(":memory:");
    store = new MessageStore(path.join(tmpDir, "store.json"));
  });

  afterEach(() => {
    db.close();
    if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("importZipExport", () => {
    it("extracts .txt and imports messages", async () => {
      const buf = makeZip({ "WhatsApp Chat with Alice Smith.txt": SAMPLE_CHAT_TEXT });
      const result = await importZipExport(buf, JID, store, db);

      expect(result.imported).toBe(4);
      expect(result.duplicates).toBe(0);
      expect(result.textFile).toBe("WhatsApp Chat with Alice Smith.txt");
      expect(result.attachmentsIgnored).toBe(0);
    });

    it("counts non-txt files as attachmentsIgnored", async () => {
      const buf = makeZip({
        "WhatsApp Chat with Alice Smith.txt": SAMPLE_CHAT_TEXT,
        "IMG-001.jpg": Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
        "VID-002.mp4": Buffer.from([0, 0, 0, 0]),
      });
      const result = await importZipExport(buf, JID, store, db);
      expect(result.attachmentsIgnored).toBe(2);
    });

    it("re-import same ZIP yields 100% duplicates", async () => {
      const buf = makeZip({ "_chat.txt": SAMPLE_CHAT_TEXT });
      await importZipExport(buf, JID, store, db);
      const r2 = await importZipExport(buf, JID, store, db);
      expect(r2.imported).toBe(0);
      expect(r2.duplicates).toBe(4);
    });

    it("ZIP with no .txt throws ZipImportError(no_text_file)", async () => {
      const buf = makeZip({ "IMG-001.jpg": Buffer.from([1, 2, 3]) });
      await expect(importZipExport(buf, JID, store, db)).rejects.toMatchObject({
        name: "ZipImportError",
        code: "no_text_file",
      });
    });

    it("invalid ZIP buffer throws ZipImportError(invalid_zip)", async () => {
      const notZip = Buffer.from("definitely not a zip");
      await expect(importZipExport(notZip, JID, store, db)).rejects.toBeInstanceOf(ZipImportError);
    });

    it("infers chatJid from filename when chats table has matching display_name", async () => {
      db.upsertChat({ jid: JID, displayName: "Alice Smith", isGroup: false });
      const buf = makeZip({ "WhatsApp Chat with Alice Smith.txt": SAMPLE_CHAT_TEXT });
      const result = await importZipExport(buf, undefined, store, db);

      expect(result.inferredChatJid).toBe(JID);
      expect(result.imported).toBe(4);
    });

    it("throws missing_chat_jid when no chatJid and no inference match", async () => {
      const buf = makeZip({ "WhatsApp Chat with Unknown Person.txt": SAMPLE_CHAT_TEXT });
      await expect(importZipExport(buf, undefined, store, db)).rejects.toMatchObject({
        name: "ZipImportError",
        code: "missing_chat_jid",
      });
    });

    it("prefers _chat.txt over random .txt", async () => {
      const buf = makeZip({
        "readme.txt": "just a readme",
        "_chat.txt": SAMPLE_CHAT_TEXT,
      });
      const result = await importZipExport(buf, JID, store, db);
      expect(result.textFile).toBe("_chat.txt");
      expect(result.imported).toBe(4);
    });

    it("messages actually land in MessageStore", async () => {
      const buf = makeZip({ "_chat.txt": SAMPLE_CHAT_TEXT });
      await importZipExport(buf, JID, store, db);
      expect(store.get(JID)).toHaveLength(4);
    });
  });

  describe("isZipMimeType", () => {
    it("recognises zip mimetypes", () => {
      expect(isZipMimeType("application/zip")).toBe(true);
      expect(isZipMimeType("application/x-zip-compressed")).toBe(true);
      expect(isZipMimeType("application/octet-stream")).toBe(true);
      expect(isZipMimeType("application/pdf")).toBe(false);
      expect(isZipMimeType(null)).toBe(false);
      expect(isZipMimeType(undefined)).toBe(false);
    });
  });

  describe("isWhatsAppExportFilename", () => {
    it("matches WhatsApp export filenames", () => {
      expect(isWhatsAppExportFilename("WhatsApp Chat with Alice.zip")).toBe(true);
      expect(isWhatsAppExportFilename("WhatsApp_Chat_with_Bob.zip")).toBe(true);
      expect(isWhatsAppExportFilename("whatsapp chat.zip")).toBe(true);
      expect(isWhatsAppExportFilename("random.zip")).toBe(false);
      expect(isWhatsAppExportFilename("WhatsApp Chat with Alice.pdf")).toBe(false);
      expect(isWhatsAppExportFilename(null)).toBe(false);
    });
  });

  describe("REST endpoint", () => {
    function buildApp() {
      const fakeWa = { store, getStatus: () => "connected", getQr: () => null, getPairingCode: () => null, wipeAuthState: () => {}, getSocket: () => null } as unknown as WhatsAppConnection;
      const app = express();
      app.use(express.json());
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

    it("POST /api/import/zip-export with chatJid returns import stats", async () => {
      const buf = makeZip({ "WhatsApp Chat with Alice.txt": SAMPLE_CHAT_TEXT });
      const res = await request(buildApp())
        .post("/api/import/zip-export")
        .field("chatJid", JID)
        .attach("file", buf, { filename: "export.zip", contentType: "application/zip" });

      expect(res.status).toBe(200);
      expect(res.body.imported).toBe(4);
      expect(res.body.textFile).toBe("WhatsApp Chat with Alice.txt");
    });

    it("POST without chatJid + failed inference returns 400", async () => {
      const buf = makeZip({ "WhatsApp Chat with Unknown.txt": SAMPLE_CHAT_TEXT });
      const res = await request(buildApp())
        .post("/api/import/zip-export")
        .attach("file", buf, { filename: "export.zip", contentType: "application/zip" });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe("missing_chat_jid");
    });

    it("POST without file returns 400", async () => {
      const res = await request(buildApp()).post("/api/import/zip-export").field("chatJid", JID);
      expect(res.status).toBe(400);
      expect(res.body.error).toBe("missing_file");
    });

    it("POST with invalid ZIP returns 400", async () => {
      const res = await request(buildApp())
        .post("/api/import/zip-export")
        .field("chatJid", JID)
        .attach("file", Buffer.from("not a zip"), { filename: "fake.zip", contentType: "application/zip" });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe("invalid_zip");
    });
  });
});
