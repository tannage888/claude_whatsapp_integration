import { readdirSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";

/**
 * Signal sessions occasionally break — a "Bad MAC" or a session file that has
 * gone missing entirely. Baileys surfaces the symptom as a CIPHERTEXT stub: a
 * message arrives, fails to decrypt, and carries no body. Nothing downstream
 * can tell that apart from a chat that simply went quiet, so the messages are
 * dropped in silence and the contact looks dormant.
 *
 * This tracks those failures per identity, and repairs the session by deleting
 * it — the next inbound message then forces a fresh prekey handshake.
 */

const FAILURE_THRESHOLD = 3;
const HEAL_COOLDOWN_MS = 6 * 60 * 60 * 1000;
const MAX_HEAL_ATTEMPTS = 3;

export interface SessionHealthEntry {
  identity: string;
  chatJid: string | null;
  failures: number;
  firstFailureAt: number;
  lastFailureAt: number;
  healedAt: number | null;
  healAttempts: number;
}

/** `81995354882069@lid` / `447753223290@s.whatsapp.net` → `81995354882069`. */
export function toIdentity(jid: string): string {
  const bare = jid.split("@")[0] ?? jid;
  return (bare.split(":")[0] ?? bare).replace(/[^0-9]/g, "");
}

export class SessionHealth {
  private entries = new Map<string, SessionHealthEntry>();

  constructor(
    private readonly authStatePath: string,
    private readonly opts: {
      autoHeal?: boolean;
      onBroken?: (entry: SessionHealthEntry) => void;
      now?: () => number;
    } = {}
  ) {}

  private now(): number {
    return this.opts.now ? this.opts.now() : Date.now();
  }

  /**
   * A message failed to decrypt. `senderJid` is the identity that owns the
   * broken session — the participant in a group, the chat itself otherwise.
   */
  recordFailure(chatJid: string, senderJid?: string | null): SessionHealthEntry {
    const identity = toIdentity(senderJid || chatJid);
    const ts = this.now();
    const existing = this.entries.get(identity);

    const entry: SessionHealthEntry = existing
      ? { ...existing, failures: existing.failures + 1, lastFailureAt: ts }
      : {
          identity,
          chatJid,
          failures: 1,
          firstFailureAt: ts,
          lastFailureAt: ts,
          healedAt: null,
          healAttempts: 0,
        };

    this.entries.set(identity, entry);

    if (entry.failures >= FAILURE_THRESHOLD && this.shouldHeal(entry)) {
      this.opts.onBroken?.(entry);
      if (this.opts.autoHeal !== false) this.heal(identity);
    }
    return entry;
  }

  /** Decryption succeeded — the session recovered, so stop tracking it. */
  recordSuccess(chatJid: string, senderJid?: string | null): void {
    this.entries.delete(toIdentity(senderJid || chatJid));
  }

  private shouldHeal(entry: SessionHealthEntry): boolean {
    if (entry.healAttempts >= MAX_HEAL_ATTEMPTS) return false;
    if (entry.healedAt === null) return true;
    return this.now() - entry.healedAt >= HEAL_COOLDOWN_MS;
  }

  /**
   * Delete every device session for an identity. Losing a session costs
   * nothing — it is renegotiated on the next message — whereas keeping a
   * broken one silently drops every message in the chat.
   */
  heal(identity: string): number {
    if (!existsSync(this.authStatePath)) return 0;

    const prefix = `session-${identity}.`;
    let removed = 0;
    for (const file of readdirSync(this.authStatePath)) {
      if (!file.startsWith(prefix) || !file.endsWith(".json")) continue;
      try {
        rmSync(join(this.authStatePath, file), { force: true });
        removed++;
      } catch {
        // A session we cannot delete is no worse than one we never tried to.
      }
    }

    const entry = this.entries.get(identity);
    if (entry) {
      this.entries.set(identity, {
        ...entry,
        healedAt: this.now(),
        healAttempts: entry.healAttempts + 1,
        failures: 0,
      });
    }
    return removed;
  }

  /** Identities currently failing to decrypt, worst first. */
  report(): SessionHealthEntry[] {
    return [...this.entries.values()].sort((a, b) => b.failures - a.failures);
  }

  /** Identities that have crossed the threshold and are still failing. */
  broken(): SessionHealthEntry[] {
    return this.report().filter((e) => e.failures >= FAILURE_THRESHOLD);
  }
}
