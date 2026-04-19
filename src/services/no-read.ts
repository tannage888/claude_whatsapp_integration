import type { StateDb } from "./state-db.js";
import type { MessageStore } from "./message-store.js";
import { resolveIdentifier } from "../utils/jid.js";

export class NoReadService {
  constructor(
    private readonly db: StateDb,
    private readonly store: MessageStore
  ) {}

  list() {
    return this.db.listNoRead();
  }

  /** Resolve identifier, add to no-read list, and purge existing data. */
  add(identifier: string): { jid: string } {
    const jid = resolveIdentifier(identifier);
    this.db.addNoRead(jid, identifier !== jid ? identifier : null);
    // Purge existing messages and membership rows
    this.store.purge(jid);
    this.db.deleteChatMembersForJid(jid);
    return { jid };
  }

  remove(jid: string): void {
    this.db.removeNoRead(jid);
  }

  isBlocked(jid: string): boolean {
    return this.db.isNoRead(jid);
  }
}
