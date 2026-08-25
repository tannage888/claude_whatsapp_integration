import Database from "better-sqlite3";
import type { Database as DatabaseType } from "better-sqlite3";

export interface ChatWatermark {
  chatJid: string;
  lastReviewedAt: number;
  updatedAt: number;
}

export interface NoReadEntry {
  jid: string;
  identifierInput: string | null;
  addedAt: number;
}

export interface ChatMember {
  chatJid: string;
  participantJid: string;
  displayName: string | null;
  lastVerifiedAt: number;
}

export interface ChatRow {
  jid: string;
  displayName: string | null;
  isGroup: boolean;
  lastActivityAt: number | null;
  lastSeenByDaemonAt: number | null;
}

export interface GapRow {
  id: number;
  chatJid: string | null;
  fromTs: number;
  toTs: number;
  reason: string;
  backfillAttempted: boolean;
  backfillSucceeded: boolean;
  resolvedAt: number | null;
  notes: string | null;
}

const MIGRATIONS = [
  `CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)`,
  `INSERT INTO schema_version VALUES (0)`,
  `CREATE TABLE IF NOT EXISTS chat_watermarks (
    chat_jid TEXT PRIMARY KEY,
    last_reviewed_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS no_read_list (
    jid TEXT PRIMARY KEY,
    identifier_input TEXT,
    added_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS chat_members (
    chat_jid TEXT NOT NULL,
    participant_jid TEXT NOT NULL,
    display_name TEXT,
    last_verified_at INTEGER NOT NULL,
    PRIMARY KEY (chat_jid, participant_jid)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_members_participant ON chat_members(participant_jid)`,
  `CREATE TABLE IF NOT EXISTS chats (
    jid TEXT PRIMARY KEY,
    display_name TEXT,
    is_group INTEGER NOT NULL DEFAULT 0,
    last_activity_at INTEGER,
    last_seen_by_daemon_at INTEGER
  )`,
  `CREATE TABLE IF NOT EXISTS gaps (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_jid TEXT,
    from_ts INTEGER NOT NULL,
    to_ts INTEGER NOT NULL,
    reason TEXT NOT NULL,
    backfill_attempted INTEGER NOT NULL DEFAULT 0,
    backfill_succeeded INTEGER NOT NULL DEFAULT 0,
    resolved_at INTEGER,
    notes TEXT
  )`,
];

export class StateDb {
  private db: DatabaseType;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.runMigrations();
  }

  private runMigrations(): void {
    // Run all DDL statements idempotently
    for (const sql of MIGRATIONS) {
      this.db.exec(sql);
    }
  }

  close(): void {
    this.db.close();
  }

  // ── Watermarks ────────────────────────────────────────────

  getWatermark(chatJid: string): ChatWatermark | null {
    const row = this.db
      .prepare("SELECT chat_jid, last_reviewed_at, updated_at FROM chat_watermarks WHERE chat_jid = ?")
      .get(chatJid) as { chat_jid: string; last_reviewed_at: number; updated_at: number } | undefined;
    if (!row) return null;
    return { chatJid: row.chat_jid, lastReviewedAt: row.last_reviewed_at, updatedAt: row.updated_at };
  }

  setWatermark(chatJid: string, lastReviewedAt: number): void {
    this.db
      .prepare(
        `INSERT INTO chat_watermarks (chat_jid, last_reviewed_at, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(chat_jid) DO UPDATE SET last_reviewed_at = excluded.last_reviewed_at, updated_at = excluded.updated_at`
      )
      .run(chatJid, lastReviewedAt, Date.now());
  }

  // ── No-read list ──────────────────────────────────────────

  addNoRead(jid: string, identifierInput: string | null): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO no_read_list (jid, identifier_input, added_at) VALUES (?, ?, ?)`
      )
      .run(jid, identifierInput, Date.now());
  }

  removeNoRead(jid: string): void {
    this.db.prepare("DELETE FROM no_read_list WHERE jid = ?").run(jid);
  }

  listNoRead(): NoReadEntry[] {
    return (
      this.db.prepare("SELECT jid, identifier_input, added_at FROM no_read_list").all() as Array<{
        jid: string;
        identifier_input: string | null;
        added_at: number;
      }>
    ).map((r) => ({ jid: r.jid, identifierInput: r.identifier_input, addedAt: r.added_at }));
  }

  isNoRead(jid: string): boolean {
    return !!this.db.prepare("SELECT 1 FROM no_read_list WHERE jid = ?").get(jid);
  }

  // ── Chat members ──────────────────────────────────────────

  upsertChatMember(member: Omit<ChatMember, "lastVerifiedAt"> & { lastVerifiedAt?: number }): void {
    this.db
      .prepare(
        `INSERT INTO chat_members (chat_jid, participant_jid, display_name, last_verified_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(chat_jid, participant_jid) DO UPDATE SET
           display_name = excluded.display_name,
           last_verified_at = excluded.last_verified_at`
      )
      .run(
        member.chatJid,
        member.participantJid,
        member.displayName ?? null,
        member.lastVerifiedAt ?? Date.now()
      );
  }

  findChatsForParticipant(participantJid: string): Array<{ chatJid: string; displayName: string | null; lastVerifiedAt: number }> {
    return this.findChatsForParticipants([participantJid]);
  }

  /**
   * Chats containing any of the given participant ids.
   *
   * A person has two identifiers — a phone JID and a @lid — and which one a
   * row was written under depends on how WhatsApp addressed that group.
   * Querying both is what makes membership findable regardless.
   */
  findChatsForParticipants(participantJids: string[]): Array<{ chatJid: string; displayName: string | null; lastVerifiedAt: number }> {
    const ids = [...new Set(participantJids.filter(Boolean))];
    if (ids.length === 0) return [];

    const placeholders = ids.map(() => "?").join(", ");
    return (
      this.db
        .prepare(
          // Membership rows carry no chat name — a metadata refresh writes
          // them with display_name null — so fall back to the chats table,
          // otherwise callers get bare JIDs they cannot show anyone.
          `SELECT m.chat_jid                                       AS chat_jid,
                  COALESCE(MAX(m.display_name), MAX(c.display_name)) AS display_name,
                  MAX(m.last_verified_at)                          AS last_verified_at
             FROM chat_members m
             LEFT JOIN chats c ON c.jid = m.chat_jid
            WHERE m.participant_jid IN (${placeholders})
            GROUP BY m.chat_jid`
        )
        .all(...ids) as Array<{ chat_jid: string; display_name: string | null; last_verified_at: number }>
    ).map((r) => ({ chatJid: r.chat_jid, displayName: r.display_name, lastVerifiedAt: r.last_verified_at }));
  }

  deleteChatMembersForJid(chatJid: string): void {
    this.db.prepare("DELETE FROM chat_members WHERE chat_jid = ?").run(chatJid);
    this.db.prepare("DELETE FROM chat_members WHERE participant_jid = ?").run(chatJid);
  }

  // ── Chats ─────────────────────────────────────────────────

  upsertChat(chat: Partial<ChatRow> & { jid: string }): void {
    this.db
      .prepare(
        `INSERT INTO chats (jid, display_name, is_group, last_activity_at, last_seen_by_daemon_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(jid) DO UPDATE SET
           display_name = COALESCE(excluded.display_name, display_name),
           is_group = excluded.is_group,
           last_activity_at = COALESCE(excluded.last_activity_at, last_activity_at),
           last_seen_by_daemon_at = COALESCE(excluded.last_seen_by_daemon_at, last_seen_by_daemon_at)`
      )
      .run(
        chat.jid,
        chat.displayName ?? null,
        chat.isGroup ? 1 : 0,
        chat.lastActivityAt ?? null,
        chat.lastSeenByDaemonAt ?? null
      );
  }

  getChat(jid: string): ChatRow | null {
    const r = this.db
      .prepare("SELECT * FROM chats WHERE jid = ?")
      .get(jid) as { jid: string; display_name: string | null; is_group: number; last_activity_at: number | null; last_seen_by_daemon_at: number | null } | undefined;
    if (!r) return null;
    return {
      jid: r.jid,
      displayName: r.display_name,
      isGroup: !!r.is_group,
      lastActivityAt: r.last_activity_at,
      lastSeenByDaemonAt: r.last_seen_by_daemon_at,
    };
  }

  listChats(): ChatRow[] {
    return (
      this.db.prepare("SELECT * FROM chats ORDER BY last_activity_at DESC").all() as Array<{
        jid: string;
        display_name: string | null;
        is_group: number;
        last_activity_at: number | null;
        last_seen_by_daemon_at: number | null;
      }>
    ).map((r) => ({
      jid: r.jid,
      displayName: r.display_name,
      isGroup: !!r.is_group,
      lastActivityAt: r.last_activity_at,
      lastSeenByDaemonAt: r.last_seen_by_daemon_at,
    }));
  }

  // ── Gaps ──────────────────────────────────────────────────

  recordGap(gap: Omit<GapRow, "id" | "resolvedAt" | "notes">): number {
    const result = this.db
      .prepare(
        `INSERT INTO gaps (chat_jid, from_ts, to_ts, reason, backfill_attempted, backfill_succeeded)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(
        gap.chatJid ?? null,
        gap.fromTs,
        gap.toTs,
        gap.reason,
        gap.backfillAttempted ? 1 : 0,
        gap.backfillSucceeded ? 1 : 0
      );
    return result.lastInsertRowid as number;
  }

  updateGap(id: number, update: Partial<Pick<GapRow, "backfillAttempted" | "backfillSucceeded" | "resolvedAt" | "notes">>): void {
    const sets: string[] = [];
    const values: unknown[] = [];
    if (update.backfillAttempted !== undefined) { sets.push("backfill_attempted = ?"); values.push(update.backfillAttempted ? 1 : 0); }
    if (update.backfillSucceeded !== undefined) { sets.push("backfill_succeeded = ?"); values.push(update.backfillSucceeded ? 1 : 0); }
    if (update.resolvedAt !== undefined) { sets.push("resolved_at = ?"); values.push(update.resolvedAt); }
    if (update.notes !== undefined) { sets.push("notes = ?"); values.push(update.notes); }
    if (sets.length === 0) return;
    values.push(id);
    this.db.prepare(`UPDATE gaps SET ${sets.join(", ")} WHERE id = ?`).run(...values);
  }

  resolveGap(id: number): void {
    this.updateGap(id, { resolvedAt: Date.now() });
  }

  listGaps(onlyUnresolved = false): GapRow[] {
    const sql = onlyUnresolved
      ? "SELECT * FROM gaps WHERE resolved_at IS NULL ORDER BY from_ts DESC"
      : "SELECT * FROM gaps ORDER BY from_ts DESC";
    return (this.db.prepare(sql).all() as Array<{
      id: number; chat_jid: string | null; from_ts: number; to_ts: number;
      reason: string; backfill_attempted: number; backfill_succeeded: number;
      resolved_at: number | null; notes: string | null;
    }>).map((r) => ({
      id: r.id,
      chatJid: r.chat_jid,
      fromTs: r.from_ts,
      toTs: r.to_ts,
      reason: r.reason,
      backfillAttempted: !!r.backfill_attempted,
      backfillSucceeded: !!r.backfill_succeeded,
      resolvedAt: r.resolved_at,
      notes: r.notes,
    }));
  }

  getGap(id: number): GapRow | null {
    const r = this.db.prepare("SELECT * FROM gaps WHERE id = ?").get(id) as {
      id: number; chat_jid: string | null; from_ts: number; to_ts: number;
      reason: string; backfill_attempted: number; backfill_succeeded: number;
      resolved_at: number | null; notes: string | null;
    } | undefined;
    if (!r) return null;
    return {
      id: r.id,
      chatJid: r.chat_jid,
      fromTs: r.from_ts,
      toTs: r.to_ts,
      reason: r.reason,
      backfillAttempted: !!r.backfill_attempted,
      backfillSucceeded: !!r.backfill_succeeded,
      resolvedAt: r.resolved_at,
      notes: r.notes,
    };
  }
}
