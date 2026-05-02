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

/**
 * Resolves a contact's display name (extracted from the export filename) to a
 * WhatsApp JID. Used as a fallback when the daemon's own `chats` table doesn't
 * contain the 1:1 contact — e.g. the deployment can ask Kit's contact registry.
 */
export type NameResolver = (
  name: string
) => Promise<string | null> | string | null;

// WhatsApp export filename patterns:
//   "WhatsApp Chat with Alice Smith.txt"
//   "_chat.txt" (iOS default)
const WA_CHAT_FILENAME_RE = /whatsapp chat with (.+?)\.txt$/i;

/**
 * Extracts a .txt transcript from a WhatsApp Export ZIP and imports it.
 *
 * If `chatJid` is omitted, the filename is matched against `chats.display_name`
 * in the DB to infer the target. If that fails and `nameResolver` is provided,
 * the contact name extracted from the filename is passed to the resolver as a
 * second-chance lookup. If both fail, ZipImportError is thrown.
 */
export async function importZipExport(
  zipBuffer: Buffer,
  chatJid: string | undefined,
  store: MessageStore,
  db: StateDb,
  nameResolver?: NameResolver
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

  // Fallback: ask the deployment-supplied resolver (e.g. Kit's contact registry).
  // The daemon's own `chats` table never contains 1:1 contacts with display
  // names, so without this fallback any auto-import of a 1:1 export would fail.
  const filenameContact = extractContactNameFromFilename(textFile);
  if (!resolvedJid && nameResolver && filenameContact) {
    const resolved = await nameResolver(filenameContact);
    if (resolved) {
      resolvedJid = resolved;
      inferred = resolved;
    }
  }

  if (!resolvedJid) {
    throw new ZipImportError(
      `cannot determine target chatJid for "${textFile}" — pass chatJid explicitly`,
      "missing_chat_jid"
    );
  }

  // Determine the contact's display name so the importer can mark "me"
  // messages with fromMe=true. Prefer the name embedded in the filename
  // ("WhatsApp Chat with <name>.txt") since that's the address-book name
  // the iOS export uses for the contact's transcript lines too. Fall back
  // to the chats table when the file is the iOS-default `_chat.txt`.
  const contactName =
    extractContactNameFromFilename(textFile) ??
    db.getChat(resolvedJid)?.displayName ??
    null;

  const result = await importPhoneExport(text, resolvedJid, store, db, contactName);

  return {
    ...result,
    textFile,
    attachmentsIgnored,
    inferredChatJid: inferred,
  };
}

function inferChatJidFromFilename(filename: string, db: StateDb): string | null {
  const displayName = extractContactNameFromFilename(filename);
  if (!displayName) return null;

  const chat = db.listChats().find((c) => c.displayName?.toLowerCase() === displayName.toLowerCase());
  return chat?.jid ?? null;
}

function extractContactNameFromFilename(filename: string): string | null {
  const match = WA_CHAT_FILENAME_RE.exec(filename);
  const name = match?.[1]?.trim();
  return name && name.length > 0 ? name : null;
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
