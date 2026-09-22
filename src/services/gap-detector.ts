import type { StateDb } from "./state-db.js";
import type { MessageStore } from "./message-store.js";

const GAP_THRESHOLD_MS = 60_000; // 60 seconds

/**
 * Written to `notes` when a gap is closed because the history sync completed
 * and brought nothing for that chat. It records the absence of evidence, not
 * a recovery — see `settleQuietGaps`.
 */
export const NO_EVIDENCE_NOTE = "no evidence of missed traffic";

export interface GapDetectionResult {
  gapsRecorded: number;
  alreadyCovered: number;
}

/**
 * Records the windows during which the daemon was not listening, and closes
 * them once the missing messages turn up.
 *
 * The messages in a gap are NEWER than everything held for that chat, and
 * `fetchMessageHistory` only pages BACKWARDS from an anchor — so there is no
 * on-demand call that can fill a trailing gap. What actually recovers it is the
 * history sync WhatsApp performs on reconnect, which arrives on
 * `messaging-history.set` some seconds after the socket opens.
 *
 * Detection therefore runs at startup and coverage is re-checked as history
 * lands. Checking once, synchronously, at startup is what made every gap look
 * like a failure: the verdict was taken before the data could possibly arrive.
 */
export class GapDetector {
  constructor(
    private readonly db: StateDb,
    private readonly store: MessageStore
  ) {}

  /**
   * On startup: compare last_seen_by_daemon_at for each chat to now, and record
   * a gap row for every chat that went unwatched. Gaps the store already covers
   * (the daemon restarted faster than the store went stale) are resolved at once;
   * the rest wait for `reviewOpenGaps`.
   */
  detect(): GapDetectionResult {
    const now = Date.now();
    let gapsRecorded = 0;
    let alreadyCovered = 0;

    for (const chat of this.db.listChats()) {
      // MessageStore drops @broadcast traffic, so a gap recorded against one
      // could never be shown as covered — it would sit open for ever.
      if (chat.jid.endsWith("@broadcast")) continue;

      const lastSeen = chat.lastSeenByDaemonAt;
      if (!lastSeen) continue;
      if (now - lastSeen < GAP_THRESHOLD_MS) continue;

      const gapId = this.db.recordGap({
        chatJid: chat.jid,
        fromTs: lastSeen,
        toTs: now,
        reason: "gateway_offline",
        backfillAttempted: false,
        backfillSucceeded: false,
      });
      gapsRecorded++;

      if (this.isCovered(chat.jid, lastSeen, now)) {
        this.close(gapId);
        alreadyCovered++;
      }
    }

    return { gapsRecorded, alreadyCovered };
  }

  /**
   * Re-check every open gap against the store. Call this whenever history
   * lands — a gap becomes resolved the moment its window contains a message.
   * Returns the number of gaps closed by this pass.
   */
  reviewOpenGaps(): number {
    let closed = 0;

    for (const gap of this.db.listGaps(true)) {
      if (!gap.chatJid) continue;
      if (!this.isCovered(gap.chatJid, gap.fromTs, gap.toTs)) continue;
      this.close(gap.id);
      closed++;
    }

    return closed;
  }

  /**
   * Close the gaps that a completed history sync has answered in the negative.
   *
   * `detect` cannot tell a chat that lost messages from one that simply had
   * nothing to say — at startup neither has anything in the window. So it
   * records a gap for every unwatched chat and lets the evidence decide. For a
   * chat that stayed silent the evidence never comes, and the row sits open for
   * ever; at one row per chat per restart that residue becomes the whole table
   * and buries the gaps that do mean something.
   *
   * Once WhatsApp reports the sync complete (`isLatest`), silence is an answer:
   * we asked for the window and were given nothing for that chat. Close those
   * rows, noting that this records an absence of evidence rather than a
   * recovery — `backfillSucceeded` stays false because nothing was recovered.
   *
   * `decrypt_failure` gaps are deliberately left open. Those messages arrived
   * and could not be read, so their absence from the store is positive evidence
   * of loss, and no amount of history sync makes that untrue.
   *
   * Call after `reviewOpenGaps`, which claims the gaps that history did cover.
   */
  settleQuietGaps(): number {
    let settled = 0;

    for (const gap of this.db.listGaps(true)) {
      if (gap.reason !== "gateway_offline") continue;
      // Leave covered gaps to reviewOpenGaps — those were genuinely recovered.
      if (gap.chatJid && this.isCovered(gap.chatJid, gap.fromTs, gap.toTs)) continue;

      this.db.updateGap(gap.id, { backfillAttempted: true, notes: NO_EVIDENCE_NOTE });
      this.db.resolveGap(gap.id);
      settled++;
    }

    return settled;
  }

  /** Does the store hold a message inside (fromMs, toMs] for this chat? */
  private isCovered(chatJid: string, fromMs: number, toMs: number): boolean {
    return this.store.get(chatJid).some((msg) => {
      const ts = Number(msg.messageTimestamp ?? 0) * 1000;
      return ts > fromMs && ts <= toMs;
    });
  }

  private close(gapId: number): void {
    this.db.updateGap(gapId, { backfillAttempted: true, backfillSucceeded: true });
    this.db.resolveGap(gapId);
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
