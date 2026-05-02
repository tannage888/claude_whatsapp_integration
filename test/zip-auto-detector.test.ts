import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import AdmZip from "adm-zip";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { StateDb } from "../src/services/state-db.js";
import { MessageStore } from "../src/services/message-store.js";
import { ZipAutoDetector } from "../src/services/zip-auto-detector.js";
import type { proto } from "@whiskeysockets/baileys";

const SAMPLE_CHAT = `[12/04/2026, 09:01:14] Alice Smith: Hi
[12/04/2026, 09:02:00] Me: Hey`;
const MY_JID = "447999000000@s.whatsapp.net";
const ALICE_JID = "447700900123@s.whatsapp.net";

function makeZipBuffer(): Buffer {
  const zip = new AdmZip();
  zip.addFile("WhatsApp Chat with Alice Smith.txt", Buffer.from(SAMPLE_CHAT, "utf-8"));
  return zip.toBuffer();
}

function docMessage(opts: {
  fromMe: boolean;
  mimetype?: string;
  fileName?: string;
  withCaption?: boolean;
}): proto.IWebMessageInfo {
  const doc = {
    mimetype: opts.mimetype ?? "application/zip",
    fileName: opts.fileName ?? "WhatsApp Chat with Alice Smith.zip",
    fileLength: 1024,
  };
  const message = opts.withCaption
    ? { documentWithCaptionMessage: { message: { documentMessage: doc } } }
    : { documentMessage: doc };

  return {
    key: { remoteJid: MY_JID, fromMe: opts.fromMe, id: "msg123" },
    message: message as any,
    messageTimestamp: Math.floor(Date.now() / 1000),
  } as proto.IWebMessageInfo;
}

describe("Phase 14: ZIP auto-detector", () => {
  let db: StateDb;
  let store: MessageStore;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "wa-zipauto-test-"));
    db = new StateDb(":memory:");
    store = new MessageStore(path.join(tmpDir, "store.json"));
    // Pre-seed a chat so filename inference works
    db.upsertChat({ jid: ALICE_JID, displayName: "Alice Smith", isGroup: false });
  });

  afterEach(() => {
    db.close();
    if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("shouldProcess returns true for self-sent ZIP with matching filename", () => {
    const d = new ZipAutoDetector(store, db, () => null);
    expect(d.shouldProcess(docMessage({ fromMe: true }))).toBe(true);
  });

  it("shouldProcess returns false when fromMe=false", () => {
    const d = new ZipAutoDetector(store, db, () => null);
    expect(d.shouldProcess(docMessage({ fromMe: false }))).toBe(false);
  });

  it("shouldProcess returns false for non-ZIP mimetype", () => {
    const d = new ZipAutoDetector(store, db, () => null);
    expect(d.shouldProcess(docMessage({ fromMe: true, mimetype: "application/pdf" }))).toBe(false);
  });

  it("shouldProcess returns false for non-matching filename", () => {
    const d = new ZipAutoDetector(store, db, () => null);
    expect(d.shouldProcess(docMessage({ fromMe: true, fileName: "random-backup.zip" }))).toBe(false);
  });

  it("shouldProcess returns false when disabled", () => {
    const d = new ZipAutoDetector(store, db, () => null, { disabled: true });
    expect(d.shouldProcess(docMessage({ fromMe: true }))).toBe(false);
  });

  it("shouldProcess also matches documentWithCaptionMessage", () => {
    const d = new ZipAutoDetector(store, db, () => null);
    expect(d.shouldProcess(docMessage({ fromMe: true, withCaption: true }))).toBe(true);
  });

  it("handle() downloads, imports ZIP, and calls onImport", async () => {
    const onImport = vi.fn();
    const buffer = makeZipBuffer();
    const d = new ZipAutoDetector(store, db, () => null, {
      download: async () => buffer,
      onImport,
    });

    const result = await d.handle(docMessage({ fromMe: true }));
    expect(result.handled).toBe(true);
    expect(result.result?.imported).toBe(2);
    expect(result.result?.inferredChatJid).toBe(ALICE_JID);
    expect(onImport).toHaveBeenCalledTimes(1);
    expect(store.get(ALICE_JID)).toHaveLength(2);
  });

  it("handle() returns handled=false for non-matching messages", async () => {
    const d = new ZipAutoDetector(store, db, () => null, {
      download: async () => makeZipBuffer(),
    });
    const result = await d.handle(docMessage({ fromMe: false }));
    expect(result.handled).toBe(false);
  });

  it("handle() surfaces errors and calls onError without crashing", async () => {
    const onError = vi.fn();
    const d = new ZipAutoDetector(store, db, () => null, {
      download: async () => {
        throw new Error("download failed");
      },
      onError,
    });

    const result = await d.handle(docMessage({ fromMe: true }));
    expect(result.handled).toBe(false);
    expect(result.error).toBe("download failed");
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it("handle() returns error when ZIP cannot infer chat and no fallback given", async () => {
    // Wipe chat so filename inference fails
    db.close();
    db = new StateDb(":memory:");
    const d = new ZipAutoDetector(store, db, () => null, {
      download: async () => makeZipBuffer(),
    });

    const result = await d.handle(docMessage({ fromMe: true }));
    expect(result.handled).toBe(false);
    expect(result.error).toMatch(/chatJid/i);
  });

  it("handle() falls back to nameResolver when DB inference fails", async () => {
    // Wipe chats so DB inference fails — resolver must rescue
    db.close();
    db = new StateDb(":memory:");

    const resolver = vi.fn(async (name: string) =>
      name === "Alice Smith" ? ALICE_JID : null
    );
    const d = new ZipAutoDetector(store, db, () => null, {
      download: async () => makeZipBuffer(),
      nameResolver: resolver,
    });

    const result = await d.handle(docMessage({ fromMe: true }));
    expect(result.handled).toBe(true);
    expect(result.result?.imported).toBe(2);
    expect(result.result?.inferredChatJid).toBe(ALICE_JID);
    expect(resolver).toHaveBeenCalledWith("Alice Smith");
    expect(store.get(ALICE_JID)).toHaveLength(2);
  });
});
