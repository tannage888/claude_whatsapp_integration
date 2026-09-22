import type { WASocket } from "@whiskeysockets/baileys";
import type { MessageStore } from "./message-store.js";
import { HistoryFetcher, oldestAnchor } from "./history-fetcher.js";
import type { StateDb } from "./state-db.js";
import type { MembershipService } from "./membership.js";
import { resolveIdentifier } from "../utils/jid.js";

const DEFAULT_MAX_MESSAGES_PER_CHAT = 500;
const PAGE_SIZE = 50;

export interface ScrapeContextOptions {
  maxMessagesPerChat?: number;
  since?: string;
}

export interface ScrapedChat {
  jid: string;
  displayName: string | null;
  type: "individual" | "group";
  messagesBackfilled: number;
  /**
   * Set when the chat was not requested at all. WhatsApp pages history
   * backwards from a message key, so a chat with nothing stored has no cursor
   * to reach back from — which is not the same as a chat with no history.
   */
  skipped?: "no-anchor";
}

export interface ScrapeContextResult {
  contactJid: string;
  identifier: string;
  chats: ScrapedChat[];
  totalMessagesBackfilled: number;
  membershipRefreshed: boolean;
}

export class ContactContextScraper {
  private readonly history: HistoryFetcher;

  constructor(
    private readonly db: StateDb,
    private readonly store: MessageStore,
    private readonly membership: MembershipService,
    private readonly getSocket: () => WASocket | null,
    history?: HistoryFetcher
  ) {
    this.history = history ?? new HistoryFetcher(getSocket);
  }

  async scrape(identifier: string, opts: ScrapeContextOptions = {}): Promise<ScrapeContextResult> {
    const maxPerChat = opts.maxMessagesPerChat ?? DEFAULT_MAX_MESSAGES_PER_CHAT;
    const sinceMs = opts.since ? new Date(opts.since).getTime() : undefined;
    const contactJid = resolveIdentifier(identifier);

    let contactChats = this.membership.getChatsForContact(identifier);
    let membershipRefreshed = false;

    if (contactChats.chats.length === 0) {
      await this.membership.refresh().catch(() => {});
      membershipRefreshed = true;
      contactChats = this.membership.getChatsForContact(identifier);
    }

    const results: ScrapedChat[] = [];
    let totalBackfilled = 0;

    // Always include a direct 1:1 chat entry for the contact itself
    const directJid = contactJid;
    const alreadyIncluded = contactChats.chats.some((c) => c.chatJid === directJid);
    const allChats = [
      ...contactChats.chats.map((c) => ({
        chatJid: c.chatJid,
        displayName: c.displayName,
        type: (c.chatJid.endsWith("@g.us") ? "group" : "individual") as "individual" | "group",
      })),
    ];
    if (!alreadyIncluded && !directJid.endsWith("@g.us")) {
      const existing = this.db.getChat(directJid);
      allChats.push({
        chatJid: directJid,
        displayName: existing?.displayName ?? null,
        type: "individual",
      });
    }

    for (const chat of allChats) {
      const { fetched, skipped } = await this.backfillChat(chat.chatJid, maxPerChat, sinceMs);
      results.push({
        jid: chat.chatJid,
        displayName: chat.displayName,
        type: chat.type,
        messagesBackfilled: fetched,
        ...(skipped ? { skipped } : {}),
      });
      totalBackfilled += fetched;
    }

    return {
      contactJid,
      identifier,
      chats: results,
      totalMessagesBackfilled: totalBackfilled,
      membershipRefreshed,
    };
  }

  /**
   * Page backwards through a chat's history, anchoring each request on the
   * oldest message held so far.
   *
   * The messages are counted, not stored: WhatsAppConnection's
   * `messaging-history.set` handler already buffers every batch, and
   * MessageStore.buffer does not deduplicate.
   */
  /**
   * Page backwards through a chat's history, anchoring each request on the
   * oldest message held so far.
   *
   * The messages are counted, not stored: WhatsAppConnection's
   * `messaging-history.set` handler already buffers every batch, and
   * MessageStore.buffer does not deduplicate.
   */
  private async backfillChat(
    chatJid: string,
    maxMessages: number,
    sinceMs: number | undefined
  ): Promise<{ fetched: number; skipped?: "no-anchor" }> {
    if (!this.getSocket()) return { fetched: 0 };

    const sinceSec = sinceMs !== undefined ? Math.floor(sinceMs / 1000) : undefined;
    let fetched = 0;

    try {
      while (fetched < maxMessages) {
        // Re-read after every batch: the anchor for the next request is the
        // oldest message the batch just added to the store.
        const anchor = oldestAnchor(this.store.get(chatJid));
        if (!anchor) return { fetched, ...(fetched === 0 ? { skipped: "no-anchor" as const } : {}) };
        if (sinceSec !== undefined && anchor.timestampSec < sinceSec) break;

        const batchSize = Math.min(PAGE_SIZE, maxMessages - fetched);
        const batch = await this.history.fetchOlderThan(anchor, batchSize);

        if (batch.messages.length === 0) break;
        fetched += batch.messages.length;
        if (batch.isLatest) break;
      }
    } catch {
      // A single unreachable chat must not abort the whole scrape.
      return { fetched };
    }

    return { fetched };
  }
}
