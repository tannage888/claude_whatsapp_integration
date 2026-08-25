import type { proto } from "@whiskeysockets/baileys";
import type { MessageStore } from "./message-store.js";
import type { StateDb, GapRow } from "./state-db.js";

export interface TranscriptMessage {
  id: string;
  timestamp: string;
  fromMe: boolean;
  sender: { jid: string; displayName: string | null };
  type: "text" | "media" | "system";
  body: string;
  quotedMessageId: string | null;
}

export interface TranscriptChat {
  jid: string;
  type: "individual" | "group";
  displayName: string | null;
  isGroup: boolean;
}

export interface TranscriptWindow {
  from: string | null;
  to: string;
  reason: "since_last_review" | "full" | "from" | "from_to";
}

export interface TranscriptGap {
  from: string;
  to: string;
  reason: string;
  backfillAttempted: boolean;
  backfillSucceeded: boolean;
}

export interface Transcript {
  chat: TranscriptChat;
  window: TranscriptWindow;
  messages: TranscriptMessage[];
  gaps: TranscriptGap[];
  watermark: { previous: string | null; new: string };
  policy?: "no_read";
}

export type ReadMode = "since_last_review" | "full" | "from" | "from_to";

export interface ReadOptions {
  jid: string;
  mode: ReadMode;
  from?: number; // epoch ms
  to?: number;   // epoch ms
}

function msgBody(msg: proto.IWebMessageInfo): string | null {
  return (
    msg.message?.conversation ||
    msg.message?.extendedTextMessage?.text ||
    msg.message?.imageMessage?.caption ||
    msg.message?.videoMessage?.caption ||
    null
  );
}

function msgTimestampMs(msg: proto.IWebMessageInfo): number {
  return Number(msg.messageTimestamp ?? 0) * 1000;
}

function toIso(ms: number): string {
  return new Date(ms).toISOString();
}

function gapToTranscript(g: GapRow): TranscriptGap {
  return {
    from: toIso(g.fromTs),
    to: toIso(g.toTs),
    reason: g.reason,
    backfillAttempted: g.backfillAttempted,
    backfillSucceeded: g.backfillSucceeded,
  };
}

export function buildTranscript(
  opts: ReadOptions,
  store: MessageStore,
  db: StateDb
): Transcript {
  const { jid, mode } = opts;

  // No-read check
  if (db.isNoRead(jid)) {
    const now = toIso(Date.now());
    return {
      chat: { jid, type: jid.endsWith("@g.us") ? "group" : "individual", displayName: null, isGroup: jid.endsWith("@g.us") },
      window: { from: null, to: now, reason: "full" },
      messages: [],
      gaps: [],
      watermark: { previous: null, new: now },
      policy: "no_read",
    };
  }

  const chatRow = db.getChat(jid);
  const isGroup = jid.endsWith("@g.us");

  const chat: TranscriptChat = {
    jid,
    type: isGroup ? "group" : "individual",
    displayName: chatRow?.displayName ?? null,
    isGroup,
  };

  const watermarkRow = db.getWatermark(jid);
  const previousWatermark = watermarkRow ? toIso(watermarkRow.lastReviewedAt) : null;

  let fromMs: number | null = null;
  let toMs: number = Date.now();
  let reason: TranscriptWindow["reason"] = "full";

  if (mode === "since_last_review") {
    fromMs = watermarkRow?.lastReviewedAt ?? null;
    reason = "since_last_review";
  } else if (mode === "full") {
    fromMs = null;
    reason = "full";
  } else if (mode === "from") {
    fromMs = opts.from ?? null;
    reason = "from";
  } else if (mode === "from_to") {
    fromMs = opts.from ?? null;
    toMs = opts.to ?? Date.now();
    reason = "from_to";
  }

  const rawMsgs = store.get(jid);
  const filtered = rawMsgs.filter((msg) => {
    const ts = msgTimestampMs(msg);
    // Drop messages with invalid/zero timestamps — they crash toIso downstream
    // and represent malformed imports rather than real conversation content.
    if (!Number.isFinite(ts) || ts <= 0) return false;
    if (fromMs !== null && ts <= fromMs) return false;
    if (ts > toMs) return false;
    return !!msgBody(msg);
  });

  const messages: TranscriptMessage[] = filtered.map((msg) => {
    const ts = msgTimestampMs(msg);
    const isGroupMsg = jid.endsWith("@g.us");
    // Group senders arrive as @lid. Prefer the phone form the key carries,
    // then the learned lid map, so callers get an id they can match against
    // a contact rather than an opaque identifier.
    const key = msg.key as (typeof msg.key & {
      participantPn?: string | null;
      participantLid?: string | null;
    }) | null | undefined;
    const rawParticipant =
      (key?.participant as string | undefined) ?? (msg.participant as string | undefined);
    const participantLid =
      key?.participantLid ?? (rawParticipant?.endsWith("@lid") ? rawParticipant : undefined);
    const senderJid = isGroupMsg
      ? (key?.participantPn ??
         (participantLid ? store.phoneForLid(participantLid) : undefined) ??
         rawParticipant ??
         jid)
      : jid;
    const body = msgBody(msg) ?? "";

    return {
      id: msg.key?.id ?? "",
      timestamp: toIso(ts),
      fromMe: msg.key?.fromMe ?? false,
      sender: { jid: senderJid, displayName: null },
      type: "text",
      body,
      quotedMessageId: msg.message?.extendedTextMessage?.contextInfo?.stanzaId ?? null,
    };
  });

  const newWatermark = toIso(toMs);

  // Gaps for this chat within the window
  const allGaps = db.listGaps().filter((g) => {
    if (g.chatJid && g.chatJid !== jid) return false;
    if (fromMs !== null && g.toTs < fromMs) return false;
    if (g.fromTs > toMs) return false;
    return true;
  });

  return {
    chat,
    window: {
      from: fromMs !== null ? toIso(fromMs) : null,
      to: newWatermark,
      reason,
    },
    messages,
    gaps: allGaps.map(gapToTranscript),
    watermark: { previous: previousWatermark, new: newWatermark },
  };
}
