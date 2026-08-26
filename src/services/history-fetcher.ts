import type { proto, WAMessageKey, WASocket } from "@whiskeysockets/baileys";

const DEFAULT_TIMEOUT_MS = 20_000;

/**
 * On-demand history retrieval.
 *
 * `socket.fetchMessageHistory` does not return messages. Its real signature is
 *
 *   fetchMessageHistory(count, oldestMsgKey, oldestMsgTimestamp) => Promise<string>
 *
 * and the string it resolves to is a request-session id. The messages arrive
 * afterwards, asynchronously, on the `messaging-history.set` event, tagged with
 * the same id in `peerDataRequestSessionId`. Awaiting the call alone therefore
 * yields nothing — the caller has to correlate the later event.
 *
 * This wrapper does the correlation so callers can `await` a batch.
 */

export interface HistoryAnchor {
  /** Key of the oldest message already held; history is fetched older than this. */
  key: WAMessageKey;
  /** That message's timestamp, in SECONDS (WhatsApp's unit, not ms). */
  timestampSec: number;
}

export interface HistoryBatch {
  messages: proto.IWebMessageInfo[];
  /** WhatsApp reports this batch as the end of available history. */
  isLatest: boolean;
  /** No correlated batch arrived before the timeout — messages may still land later. */
  timedOut: boolean;
}

const EMPTY: HistoryBatch = { messages: [], isLatest: false, timedOut: false };

export class HistoryFetcher {
  constructor(
    private readonly getSocket: () => WASocket | null,
    private readonly timeoutMs: number = DEFAULT_TIMEOUT_MS
  ) {}

  /**
   * Request `count` messages older than `anchor` and wait for the matching
   * history batch. Resolves with an empty, non-timed-out batch when there is no
   * socket; with `timedOut: true` when the request went out but nothing came back.
   *
   * The returned messages are NOT stored — WhatsAppConnection's own
   * `messaging-history.set` handler buffers them, and MessageStore.buffer does
   * not deduplicate, so a second write here would double every message.
   */
  async fetchOlderThan(anchor: HistoryAnchor, count: number): Promise<HistoryBatch> {
    const socket = this.getSocket();
    if (!socket) return EMPTY;

    // Subscribe before issuing the request. The batch can arrive before
    // fetchMessageHistory's own promise settles, so batches seen while the
    // session id is still unknown are held and matched once it is.
    let sessionId: string | null = null;
    let settle: ((batch: HistoryBatch) => void) | null = null;
    const pending: Array<{ id: string | null | undefined; batch: HistoryBatch }> = [];

    const consider = (id: string | null | undefined, batch: HistoryBatch): void => {
      if (sessionId === null) {
        pending.push({ id, batch });
        return;
      }
      if (id !== sessionId) return;
      settle?.(batch);
      settle = null;
    };

    const onHistory = (payload: {
      messages: proto.IWebMessageInfo[];
      isLatest?: boolean;
      peerDataRequestSessionId?: string | null;
    }): void => {
      consider(payload.peerDataRequestSessionId, {
        messages: payload.messages ?? [],
        isLatest: payload.isLatest ?? false,
        timedOut: false,
      });
    };

    socket.ev.on("messaging-history.set", onHistory);

    try {
      const batch = new Promise<HistoryBatch>((resolve) => {
        settle = resolve;
      });

      sessionId = await socket.fetchMessageHistory(count, anchor.key, anchor.timestampSec);

      // Replay anything that landed while the id was unknown.
      for (const held of pending.splice(0)) consider(held.id, held.batch);

      return await this.withTimeout(batch);
    } catch {
      return EMPTY;
    } finally {
      socket.ev.off("messaging-history.set", onHistory);
    }
  }

  private withTimeout(batch: Promise<HistoryBatch>): Promise<HistoryBatch> {
    return new Promise<HistoryBatch>((resolve) => {
      const timer = setTimeout(
        () => resolve({ messages: [], isLatest: false, timedOut: true }),
        this.timeoutMs
      );
      void batch.then((b) => {
        clearTimeout(timer);
        resolve(b);
      });
    });
  }
}

/**
 * Oldest message held for a chat, as an anchor for paging further back.
 * Returns null when nothing is stored — there is then no cursor to page from.
 */
export function oldestAnchor(messages: proto.IWebMessageInfo[]): HistoryAnchor | null {
  let oldest: proto.IWebMessageInfo | null = null;
  let oldestTs = Number.POSITIVE_INFINITY;

  for (const msg of messages) {
    const ts = Number(msg.messageTimestamp ?? 0);
    if (!ts || !msg.key) continue;
    if (ts < oldestTs) {
      oldestTs = ts;
      oldest = msg;
    }
  }

  if (!oldest?.key) return null;
  return { key: oldest.key, timestampSec: oldestTs };
}
