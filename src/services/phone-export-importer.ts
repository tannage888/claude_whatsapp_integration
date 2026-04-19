import type { MessageStore } from "./message-store.js";
import type { StateDb } from "./state-db.js";

// Matches: [DD/MM/YYYY, HH:MM:SS] Sender: body
const MSG_LINE_RE = /^\[(\d{2}\/\d{2}\/\d{4}), (\d{2}:\d{2}:\d{2})\] ([^:]+): (.+)$/;

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

export function parsePhoneExport(text: string): ParsedExportMessage[] {
  const lines = text.split("\n");
  const messages: ParsedExportMessage[] = [];
  let current: ParsedExportMessage | null = null;

  for (const line of lines) {
    const match = MSG_LINE_RE.exec(line.trimEnd());
    if (match) {
      if (current) messages.push(current);
      const date = match[1]!;
      const time = match[2]!;
      const sender = match[3]!;
      const body = match[4]!;
      const [day, month, year] = date.split("/");
      const tsStr = `${year}-${month}-${day}T${time}`;
      const timestamp = new Date(tsStr).getTime();
      current = { timestamp, sender: sender.trim(), body: body.trim() };
    } else if (current && line.trim()) {
      // Multi-line message continuation
      current.body += "\n" + line.trimEnd();
    }
  }
  if (current) messages.push(current);
  return messages;
}

export async function importPhoneExport(
  text: string,
  chatJid: string,
  store: MessageStore,
  db: StateDb
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

  for (const msg of parsed) {
    const key = `${msg.timestamp}|${msg.body}`;
    if (existingSet.has(key)) {
      duplicates++;
      continue;
    }
    existingSet.add(key);

    // Synthesize a proto-like message object for the store
    const synthetic = {
      key: {
        remoteJid: chatJid,
        fromMe: false,
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
