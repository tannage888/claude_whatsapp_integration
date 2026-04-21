import AdmZip from "adm-zip";
import type { MessageStore } from "./message-store.js";
import type { StateDb } from "./state-db.js";
import { importPhoneExport, type ImportResult } from "./phone-export-importer.js";

export class ZipImportError extends Error {
  constructor(message: string, public readonly code: string) {
    super(message);
    this.name = "ZipImportError";
  }
}

export interface ZipImportResult extends ImportResult {
  textFile: string;
  attachmentsIgnored: number;
  inferredChatJid: string | null;
}

// WhatsApp export filename patterns:
//   "WhatsApp Chat with Alice Smith.txt"
//   "_chat.txt" (iOS default)
const WA_CHAT_FILENAME_RE = /whatsapp chat with (.+?)\.txt$/i;

/**
 * Extracts a .txt transcript from a WhatsApp Export ZIP and imports it.
 *
 * If `chatJid` is omitted, the filename is matched against `chats.display_name`
 * in the DB to infer the target. If inference fails, ZipImportError is thrown.
 */
export async function importZipExport(
  zipBuffer: Buffer,
  chatJid: string | undefined,
  store: MessageStore,
  db: StateDb
): Promise<ZipImportResult> {
  let zip: AdmZip;
  try {
    zip = new AdmZip(zipBuffer);
  } catch (e) {
    throw new ZipImportError(`invalid ZIP file: ${(e as Error).message}`, "invalid_zip");
  }

  const entries = zip.getEntries();
  const textEntries = entries.filter((e) => !e.isDirectory && e.entryName.toLowerCase().endsWith(".txt"));
  if (textEntries.length === 0) {
    throw new ZipImportError("ZIP contains no .txt transcript", "no_text_file");
  }

  // Prefer "WhatsApp Chat with ..." or "_chat.txt"; otherwise the first .txt
  const preferred = textEntries.find((e) => {
    const base = e.entryName.split("/").pop() ?? e.entryName;
    return WA_CHAT_FILENAME_RE.test(base) || base.toLowerCase() === "_chat.txt";
  });
  const textEntry = preferred ?? textEntries[0]!;
  const textFile = textEntry.entryName.split("/").pop() ?? textEntry.entryName;
  const text = textEntry.getData().toString("utf-8");

  const attachmentsIgnored = entries.filter((e) => !e.isDirectory && e !== textEntry).length;

  let resolvedJid = chatJid;
  let inferred: string | null = null;
  if (!resolvedJid) {
    inferred = inferChatJidFromFilename(textFile, db);
    if (inferred) resolvedJid = inferred;
  }

  if (!resolvedJid) {
    throw new ZipImportError(
      `cannot determine target chatJid for "${textFile}" — pass chatJid explicitly`,
      "missing_chat_jid"
    );
  }

  const result = await importPhoneExport(text, resolvedJid, store, db);

  return {
    ...result,
    textFile,
    attachmentsIgnored,
    inferredChatJid: inferred,
  };
}

function inferChatJidFromFilename(filename: string, db: StateDb): string | null {
  const match = WA_CHAT_FILENAME_RE.exec(filename);
  if (!match) return null;
  const displayName = match[1]?.trim();
  if (!displayName) return null;

  const chat = db.listChats().find((c) => c.displayName?.toLowerCase() === displayName.toLowerCase());
  return chat?.jid ?? null;
}

export function isZipMimeType(mimetype: string | null | undefined): boolean {
  if (!mimetype) return false;
  const m = mimetype.toLowerCase();
  return m === "application/zip" || m === "application/x-zip-compressed" || m === "application/octet-stream";
}

export function isWhatsAppExportFilename(filename: string | null | undefined): boolean {
  if (!filename) return false;
  return /whatsapp[\s_-]*chat.*\.zip$/i.test(filename);
}
