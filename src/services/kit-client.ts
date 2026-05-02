/**
 * Kit Gateway client.
 *
 * Two narrow callbacks the daemon makes back to the Kit gateway after
 * a ZIP export is processed:
 *
 *  1. resolveContactName — when the export filename can't be matched to
 *     a JID via the daemon's own chats table, ask Kit's contact registry.
 *     Used as the ZipAutoDetector's NameResolver fallback.
 *
 *  2. notifyImportComplete — once messages from a ZIP are in MessageStore,
 *     ping Kit so it can pull the new transcript and queue a /kit-captures
 *     review card. Used by both the auto-detector's onImport callback and
 *     the manual POST /api/import/zip-export route.
 *
 * Both calls are best-effort: failures log a warning and return `null`
 * (or void) rather than throwing, so a Kit outage never breaks the daemon.
 */

export type FetchFn = typeof fetch;

export interface KitImportNotification {
  chatJid: string;
  imported?: number;
  duplicates?: number;
  textFile?: string;
}

export class KitClient {
  constructor(
    private readonly baseUrl: string,
    private readonly fetchFn: FetchFn = fetch
  ) {}

  /**
   * Resolve a contact name (e.g. "Alice Smith" extracted from
   * "WhatsApp Chat with Alice Smith.txt") to a WhatsApp JID via Kit's
   * contact registry. Returns null on miss or on any error.
   */
  async resolveContactName(name: string): Promise<string | null> {
    try {
      const res = await this.fetchFn(`${this.baseUrl}/api/contacts/resolve-name`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      if (!res.ok) return null;
      const body = (await res.json()) as { jid?: string | null };
      return body.jid ?? null;
    } catch (err) {
      console.warn(
        `⚠️  Kit name resolver failed for "${name}": ${(err as Error).message}`
      );
      return null;
    }
  }

  /**
   * Tell Kit a ZIP has been imported into the daemon's MessageStore so
   * Kit can pull the new transcript and queue a review card. Best-effort:
   * a failure here just means the user has to trigger the capture
   * manually via /kit-captures or the sweep.
   */
  async notifyImportComplete(payload: KitImportNotification): Promise<void> {
    try {
      await this.fetchFn(`${this.baseUrl}/api/zip-import-complete`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
    } catch (err) {
      console.warn(
        `⚠️  Kit import-complete webhook failed for ${payload.chatJid}: ${(err as Error).message}`
      );
    }
  }
}
