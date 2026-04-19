import * as fs from "fs";
import type { proto } from "@whiskeysockets/baileys";

const SAVE_INTERVAL_MS = 60_000;
const CAP_PER_JID = 500;

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

  buffer(msgs: proto.IWebMessageInfo[]): void {
    for (const msg of msgs) {
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
