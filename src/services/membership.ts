import type { StateDb } from "./state-db.js";
import { resolveIdentifier, isLidJid } from "../utils/jid.js";

export interface ContactChats {
  participantJid: string;
  identifier: string;
  chats: Array<{
    chatJid: string;
    displayName: string | null;
    lastVerifiedAt: string;
  }>;
}

/**
 * The subset of MessageStore membership needs: translating between a
 * person's two WhatsApp identifiers.
 */
export interface LidResolver {
  phoneForLid(lid: string): string | undefined;
  lidForPhone(phoneJid: string): string | undefined;
  registerLid(lid: string, phoneJid: string): void;
}

export class MembershipService {
  private refreshTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly db: StateDb,
    private readonly getSocket: () => import("@whiskeysockets/baileys").WASocket | null,
    private readonly refreshHours: number = 24,
    private readonly lids?: LidResolver
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
        // Baileys reports `id` in whatever form the group is addressed with
        // (@lid for most groups now) and carries the phone form separately.
        // Record both, and teach the lid map the pairing while we have it.
        const ids = new Set<string>();
        if (participant.id) ids.add(participant.id);

        const lid =
          participant.lid ?? (participant.id?.endsWith("@lid") ? participant.id : undefined);
        const phoneJid =
          participant.jid ??
          (participant.id?.endsWith("@s.whatsapp.net") ? participant.id : undefined) ??
          (lid ? this.lids?.phoneForLid(lid) : undefined);

        if (phoneJid) ids.add(phoneJid);
        if (lid && phoneJid) this.lids?.registerLid(lid, phoneJid);

        for (const participantJid of ids) {
          this.db.upsertChatMember({
            chatJid,
            participantJid,
            displayName: null,
            lastVerifiedAt: Date.now(),
          });
        }
        membersUpdated++;
      }
    }

    return { groupsRefreshed: Object.keys(groups).length, membersUpdated };
  }

  /** Query which chats a contact belongs to. */
  getChatsForContact(identifier: string): ContactChats {
    const participantJid = resolveIdentifier(identifier);

    // Membership rows are written under whichever id WhatsApp used, so look
    // the person up under both. Without this a phone-number lookup misses
    // every lid-addressed group — which is now nearly all of them.
    const candidates = [participantJid];
    const lid = isLidJid(participantJid)
      ? participantJid
      : this.lids?.lidForPhone(participantJid);
    if (lid) candidates.push(lid);
    if (isLidJid(participantJid)) {
      const phone = this.lids?.phoneForLid(participantJid);
      if (phone) candidates.push(phone);
    }

    const rows = this.db.findChatsForParticipants(candidates);
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
