import type { StateDb } from "./state-db.js";
import { resolveIdentifier } from "../utils/jid.js";

export interface ContactChats {
  participantJid: string;
  identifier: string;
  chats: Array<{
    chatJid: string;
    displayName: string | null;
    lastVerifiedAt: string;
  }>;
}

export class MembershipService {
  private refreshTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly db: StateDb,
    private readonly getSocket: () => import("@whiskeysockets/baileys").WASocket | null,
    private readonly refreshHours: number = 24
  ) {}

  /** Called on every incoming group message to update the membership table. */
  recordMember(chatJid: string, participantJid: string, displayName: string | null): void {
    this.db.upsertChatMember({ chatJid, participantJid, displayName, lastVerifiedAt: Date.now() });
    this.db.upsertChat({ jid: chatJid, isGroup: true, lastActivityAt: Date.now() });
  }

  /** Walk all participating groups and refresh the member cache. */
  async refresh(): Promise<{ groupsRefreshed: number; membersUpdated: number }> {
    const socket = this.getSocket();
    if (!socket) return { groupsRefreshed: 0, membersUpdated: 0 };

    const groups = await socket.groupFetchAllParticipating();
    let membersUpdated = 0;

    for (const [chatJid, meta] of Object.entries(groups)) {
      this.db.upsertChat({ jid: chatJid, displayName: meta.subject ?? null, isGroup: true, lastActivityAt: Date.now() });
      for (const participant of meta.participants ?? []) {
        this.db.upsertChatMember({
          chatJid,
          participantJid: participant.id,
          displayName: null,
          lastVerifiedAt: Date.now(),
        });
        membersUpdated++;
      }
    }

    return { groupsRefreshed: Object.keys(groups).length, membersUpdated };
  }

  /** Query which chats a contact belongs to. */
  getChatsForContact(identifier: string): ContactChats {
    const participantJid = resolveIdentifier(identifier);
    const rows = this.db.findChatsForParticipant(participantJid);
    return {
      participantJid,
      identifier,
      chats: rows.map((r) => ({
        chatJid: r.chatJid,
        displayName: r.displayName,
        lastVerifiedAt: new Date(r.lastVerifiedAt).toISOString(),
      })),
    };
  }

  startScheduledRefresh(): void {
    const intervalMs = this.refreshHours * 60 * 60 * 1000;
    this.refreshTimer = setInterval(() => {
      this.refresh().catch(() => {});
    }, intervalMs);
  }

  stopScheduledRefresh(): void {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
  }
}
