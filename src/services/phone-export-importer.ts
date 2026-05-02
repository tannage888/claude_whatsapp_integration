import type { MessageStore } from "./message-store.js";
import type { StateDb } from "./state-db.js";

// iOS:     [DD/MM/YYYY, HH:MM:SS] Sender: body   (4-digit year, brackets, HH:MM:SS)
// Android:  DD/MM/YY, HH:MM - Sender: body        (2-digit year, no brackets, HH:MM, " - " separator)
// Both: day/month order (UK/EU locale); date-month order varies by phone region.
const IOS_LINE_RE = /^\[(\d{1,2})\/(\d{1,2})\/(\d{2,4}),\s(\d{1,2}):(\d{2})(?::(\d{2}))?\]\s([^:]+):\s(.+)$/;
const ANDROID_LINE_RE = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4}),\s(\d{1,2}):(\d{2})(?::(\d{2}))?\s-\s([^:]+):\s(.+)$/;

export interface ParsedExportMessage {
  timestamp: number; // epoch ms
  sender: string;
  body: string;
}

export interface ImportResult {
  imported: number;
  duplicates: number;
  gapsResolved: number[];
}

interface ParsedHeader {
  day: string;
  month: string;
  year: string;
  hour: string;
  minute: string;
  second: string;
  sender: string;
  body: string;
}

function matchHeaderLine(line: string): ParsedHeader | null {
  const m = IOS_LINE_RE.exec(line) ?? ANDROID_LINE_RE.exec(line);
  if (!m) return null;
  return {
    day: m[1]!,
    month: m[2]!,
    year: m[3]!,
    hour: m[4]!,
    minute: m[5]!,
    second: m[6] ?? "00",
    sender: m[7]!,
    body: m[8]!,
  };
}

function tryDate(year: string, month: string, day: string, hh: string, mm: string, ss: string): number {
  const fullYear = year.length === 2 ? `20${year}` : year;
  const pad = (s: string) => s.padStart(2, "0");
  const tsStr = `${fullYear}-${pad(month)}-${pad(day)}T${pad(hh)}:${mm}:${ss}`;
  return new Date(tsStr).getTime();
}

function headerToTimestamp(h: ParsedHeader): number {
  // Phone export date order varies: UK is DD/MM, US is MM/DD. Try DD/MM first;
  // if it produces NaN (e.g. month > 12) swap to MM/DD. If both are valid we
  // keep the DD/MM result — ambiguous dates like 10/10 are interpreted that way.
  const ddmm = tryDate(h.year, h.month, h.day, h.hour, h.minute, h.second);
  if (!Number.isNaN(ddmm)) return ddmm;
  return tryDate(h.year, h.day, h.month, h.hour, h.minute, h.second);
}

export function parsePhoneExport(text: string): ParsedExportMessage[] {
  const lines = text.split("\n");
  const messages: ParsedExportMessage[] = [];
  let current: ParsedExportMessage | null = null;

  for (const line of lines) {
    const trimmed = line.trimEnd();
    const header = matchHeaderLine(trimmed);
    if (header) {
      if (current) messages.push(current);
      const timestamp = headerToTimestamp(header);
      current = { timestamp, sender: header.sender.trim(), body: header.body.trim() };
    } else if (current && line.trim()) {
      // Multi-line message continuation
      current.body += "\n" + trimmed;
    }
  }
  if (current) messages.push(current);
  return messages;
}

export async function importPhoneExport(
  text: string,
  chatJid: string,
  store: MessageStore,
  db: StateDb,
  contactName?: string | null
): Promise<ImportResult> {
  const parsed = parsePhoneExport(text);

  let imported = 0;
  let duplicates = 0;

  const existingMsgs = store.get(chatJid);
  const existingSet = new Set(
    existingMsgs.map((m) => {
      const ts = Number(m.messageTimestamp ?? 0) * 1000;
      const body =
        m.message?.conversation ||
        m.message?.extendedTextMessage?.text ||
        "";
      return `${ts}|${body}`;
    })
  );

  const normalisedContact = contactName?.trim().toLowerCase() ?? null;

  for (const msg of parsed) {
    // Skip lines whose date couldn't be parsed (NaN timestamp). Logging the
    // first such line each batch is enough — bursts mean "format mismatch".
    if (!Number.isFinite(msg.timestamp)) continue;

    const key = `${msg.timestamp}|${msg.body}`;
    if (existingSet.has(key)) {
      duplicates++;
      continue;
    }
    existingSet.add(key);

    // In a 1:1 transcript, the only senders are the contact and "me".
    // Without a contactName we can't tell them apart, so default to false.
    const fromMe =
      normalisedContact !== null &&
      msg.sender.trim().toLowerCase() !== normalisedContact;

    // Synthesize a proto-like message object for the store
    const synthetic = {
      key: {
        remoteJid: chatJid,
        fromMe,
        id: `import-${msg.timestamp}-${Math.random().toString(36).slice(2)}`,
      },
      message: { conversation: msg.body },
      messageTimestamp: Math.floor(msg.timestamp / 1000),
      participant: msg.sender,
    };
    store.buffer([synthetic as any]);
    imported++;
  }

  // Auto-resolve gaps now covered by imported messages
  const gapsResolved: number[] = [];
  if (imported > 0) {
    const gaps = db.listGaps(true).filter((g) => g.chatJid === chatJid || g.chatJid === null);
    const allMsgs = store.get(chatJid);

    for (const gap of gaps) {
      const covered = allMsgs.some((m) => {
        const ts = Number(m.messageTimestamp ?? 0) * 1000;
        return ts > gap.fromTs && ts <= gap.toTs;
      });
      if (covered) {
        db.resolveGap(gap.id);
        gapsResolved.push(gap.id);
      }
    }
  }

  return { imported, duplicates, gapsResolved };
}
