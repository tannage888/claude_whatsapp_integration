import type { proto } from "@whiskeysockets/baileys";
import type { StateDb } from "./state-db.js";
import type { MessageStore } from "./message-store.js";

const GAP_THRESHOLD_MS = 60_000; // 60 seconds

export interface GapDetectionResult {
  gapsRecorded: number;
  backfillAttempted: number;
}

export class GapDetector {
  constructor(
    private readonly db: StateDb,
    private readonly store: MessageStore,
    private readonly getSocket: () => import("@whiskeysockets/baileys").WASocket | null,
    private readonly maxMessagesPerChat: number = 500
  ) {}

  /**
   * On startup: compare last_seen_by_daemon_at for each chat to now.
   * Record gap rows and attempt backfill.
   */
  async detectAndBackfill(): Promise<GapDetectionResult> {
    const now = Date.now();
    const chats = this.db.listChats();
    let gapsRecorded = 0;
    let backfillAttempted = 0;

    for (const chat of chats) {
      const lastSeen = chat.lastSeenByDaemonAt;
      if (!lastSeen) continue;
      const gapMs = now - lastSeen;
      if (gapMs < GAP_THRESHOLD_MS) continue;

      const gapId = this.db.recordGap({
        chatJid: chat.jid,
        fromTs: lastSeen,
        toTs: now,
        reason: "gateway_offline",
        backfillAttempted: false,
        backfillSucceeded: false,
      });
      gapsRecorded++;

      const succeeded = await this.backfillChat(chat.jid, lastSeen, now);
      this.db.updateGap(gapId, { backfillAttempted: true, backfillSucceeded: succeeded });
      backfillAttempted++;
    }

    return { gapsRecorded, backfillAttempted };
  }

  /**
   * Attempt to fetch message history for a chat to fill the gap.
   * Returns true if messages were found within the gap window.
   */
  private async backfillChat(chatJid: string, fromMs: number, toMs: number): Promise<boolean> {
    const socket = this.getSocket();
    if (!socket) return false;

    try {
      let fetched = 0;
      let cursor: string | null = null;
      const fromSec = Math.floor(fromMs / 1000);

      while (fetched < this.maxMessagesPerChat) {
        const result: { messages?: proto.IWebMessageInfo[]; cursor?: string | null } | null = await (socket as any).fetchMessageHistory(
          chatJid,
          cursor,
          50
        );

        if (!result || result.messages?.length === 0) break;

        const messages = result.messages ?? [];
        this.store.buffer(messages);
        fetched += messages.length;
        cursor = result.cursor ?? null;

        // Stop if we've gone back past the gap floor
        const oldest = messages[messages.length - 1];
        const oldestTs = Number(oldest?.messageTimestamp ?? 0);
        if (oldestTs && oldestTs < fromSec) break;
        if (!cursor) break;
      }

      // Check if any message landed within the gap window
      const stored = this.store.get(chatJid);
      return stored.some((m) => {
        const ts = Number(m.messageTimestamp ?? 0) * 1000;
        return ts > fromMs && ts <= toMs;
      });
    } catch {
      return false;
    }
  }

  /** Update last_seen_by_daemon_at for a chat on message receipt. */
  touchChat(chatJid: string): void {
    const existing = this.db.getChat(chatJid);
    this.db.upsertChat({
      jid: chatJid,
      isGroup: existing?.isGroup ?? chatJid.endsWith("@g.us"),
      lastSeenByDaemonAt: Date.now(),
      lastActivityAt: Date.now(),
    });
  }
}
