import type { proto, WASocket } from "@whiskeysockets/baileys";
import type { MessageStore } from "./message-store.js";
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
}

export interface ScrapeContextResult {
  contactJid: string;
  identifier: string;
  chats: ScrapedChat[];
  totalMessagesBackfilled: number;
  membershipRefreshed: boolean;
}

export class ContactContextScraper {
  constructor(
    private readonly db: StateDb,
    private readonly store: MessageStore,
    private readonly membership: MembershipService,
    private readonly getSocket: () => WASocket | null
  ) {}

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
      const count = await this.backfillChat(chat.chatJid, maxPerChat, sinceMs);
      results.push({
        jid: chat.chatJid,
        displayName: chat.displayName,
        type: chat.type,
        messagesBackfilled: count,
      });
      totalBackfilled += count;
    }

    return {
      contactJid,
      identifier,
      chats: results,
      totalMessagesBackfilled: totalBackfilled,
      membershipRefreshed,
    };
  }

  private async backfillChat(chatJid: string, maxMessages: number, sinceMs: number | undefined): Promise<number> {
    const socket = this.getSocket();
    if (!socket) return 0;

    const sinceSec = sinceMs !== undefined ? Math.floor(sinceMs / 1000) : undefined;
    let fetched = 0;
    let cursor: string | null = null;

    try {
      while (fetched < maxMessages) {
        const remaining = maxMessages - fetched;
        const batchSize = Math.min(PAGE_SIZE, remaining);

        const result: { messages?: proto.IWebMessageInfo[]; cursor?: string | null } | null = await (socket as any).fetchMessageHistory(
          chatJid,
          cursor,
          batchSize
        );

        if (!result) break;
        const messages = result.messages ?? [];
        if (messages.length === 0) break;

        this.store.buffer(messages);
        fetched += messages.length;
        cursor = result.cursor ?? null;

        // Stop if we've gone past the `since` floor
        if (sinceSec !== undefined) {
          const oldest = messages[messages.length - 1];
          const oldestTs = Number(oldest?.messageTimestamp ?? 0);
          if (oldestTs && oldestTs < sinceSec) break;
        }

        if (!cursor) break;
      }
    } catch {
      return fetched;
    }

    return fetched;
  }
}
