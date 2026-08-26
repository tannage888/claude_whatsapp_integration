import * as fs from "fs";
import type { proto } from "@whiskeysockets/baileys";

const SAVE_INTERVAL_MS = 60_000;
const CAP_PER_JID = 500;

/**
 * Baileys extends the proto message key with paired lid/phone identifiers.
 * They are absent from proto.IMessageKey, so they are declared here.
 */
type IdentityKey = proto.IMessageKey & {
  senderLid?: string | null;
  senderPn?: string | null;
  participantLid?: string | null;
  participantPn?: string | null;
};

export class MessageStore {
  private messages = new Map<string, proto.IWebMessageInfo[]>();
  private lidToJid = new Map<string, string>();
  private jidToLid = new Map<string, string>();
  private saveTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly storePath: string) {}

  load(): void {
    if (!fs.existsSync(this.storePath)) return;
    try {
      const data = JSON.parse(fs.readFileSync(this.storePath, "utf-8"));
      if (data.messages) {
        for (const [jid, msgs] of Object.entries(data.messages)) {
          this.messages.set(jid, msgs as proto.IWebMessageInfo[]);
        }
      }
      if (data.lidToJid) {
        for (const [lid, jid] of Object.entries(data.lidToJid)) {
          this.lidToJid.set(lid, jid as string);
          this.jidToLid.set(jid as string, lid);
        }
      }
    } catch {
      // Start fresh on corrupt file
    }
  }

  save(): void {
    try {
      const dir = this.storePath.split("/").slice(0, -1).join("/");
      if (dir && !fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const data = {
        messages: Object.fromEntries(this.messages),
        lidToJid: Object.fromEntries(this.lidToJid),
      };
      fs.writeFileSync(this.storePath, JSON.stringify(data), "utf-8");
    } catch {
      // Non-fatal
    }
  }

  startAutosave(): void {
    this.saveTimer = setInterval(() => this.save(), SAVE_INTERVAL_MS);
  }

  stopAutosave(): void {
    if (this.saveTimer) {
      clearInterval(this.saveTimer);
      this.saveTimer = null;
    }
    this.save();
  }

  registerLid(lid: string, phoneJid: string): void {
    this.lidToJid.set(lid, phoneJid);
    this.jidToLid.set(phoneJid, lid);
    const lidMsgs = this.messages.get(lid);
    if (lidMsgs?.length) {
      const existing = this.messages.get(phoneJid) ?? [];
      this.messages.set(phoneJid, [...existing, ...lidMsgs]);
      this.messages.delete(lid);
    }
  }

  /**
   * Harvest lid↔phone pairs carried on a message key.
   *
   * WhatsApp addresses group participants (and increasingly DM senders) by
   * @lid, but every key carries the phone-number form alongside it. Learning
   * from message traffic is far more complete than waiting for
   * contacts.upsert, which only ever covers people saved in your address book.
   */
  private harvestIdentity(key: IdentityKey | null | undefined): void {
    if (!key) return;

    const participantLid =
      key.participantLid ??
      (key.participant?.endsWith("@lid") ? key.participant : undefined);

    const pairs: Array<[string | null | undefined, string | null | undefined]> = [
      [participantLid, key.participantPn],
      [key.senderLid, key.senderPn],
    ];

    for (const [lid, phoneJid] of pairs) {
      if (!lid?.endsWith("@lid")) continue;
      if (!phoneJid?.endsWith("@s.whatsapp.net")) continue;
      if (this.lidToJid.get(lid) === phoneJid) continue;
      this.registerLid(lid, phoneJid);
    }
  }

  /** Look up the phone JID for a @lid, if known. */
  phoneForLid(lid: string): string | undefined {
    return this.lidToJid.get(lid);
  }

  /** Look up the @lid for a phone JID, if known. */
  lidForPhone(phoneJid: string): string | undefined {
    return this.jidToLid.get(phoneJid);
  }

  /** Number of known lid→phone mappings. */
  get lidMappingSize(): number {
    return this.lidToJid.size;
  }

  buffer(msgs: proto.IWebMessageInfo[]): void {
    for (const msg of msgs) {
      this.harvestIdentity(msg.key as IdentityKey | null | undefined);
      const rawJid = msg.key?.remoteJid;
      // NOTE: @g.us (groups) intentionally included — unlike kit gateway
      if (!rawJid || rawJid.endsWith("@broadcast")) continue;

      const jid = rawJid.endsWith("@lid")
        ? (this.lidToJid.get(rawJid) ?? rawJid)
        : rawJid;

      let stored = this.messages.get(jid);
      if (!stored) {
        stored = [];
        this.messages.set(jid, stored);
      }
      stored.push(msg);
      if (stored.length > CAP_PER_JID) {
        stored.splice(0, stored.length - CAP_PER_JID);
      }
    }
  }

  purge(jid: string): void {
    this.messages.delete(jid);
  }

  get(jid: string): proto.IWebMessageInfo[] {
    const direct = this.messages.get(jid);
    if (direct?.length) return direct;
    // buffer() files @lid traffic under the phone JID once the pairing is
    // known, so a lookup BY lid has to follow the same mapping — otherwise a
    // caller holding only a lid (gap rows, for one) sees an empty chat.
    const phone = this.lidToJid.get(jid);
    if (phone) {
      const viaPhone = this.messages.get(phone);
      if (viaPhone?.length) return viaPhone;
    }
    const lid = this.jidToLid.get(jid);
    if (lid) return this.messages.get(lid) ?? [];
    return [];
  }

  getAll(): Map<string, proto.IWebMessageInfo[]> {
    return this.messages;
  }

  getStats(): Array<{ jid: string; count: number }> {
    return Array.from(this.messages.entries())
      .map(([jid, msgs]) => ({ jid, count: msgs.length }))
      .sort((a, b) => b.count - a.count);
  }

  get size(): number {
    return this.messages.size;
  }
}
