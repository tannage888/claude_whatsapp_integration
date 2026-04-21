# Claude WhatsApp Integration — Specification

**Status:** Draft v0.1 — pending user review
**Owner:** Sean
**Last updated:** 2026-04-19

A standalone module that lets coding projects integrate with WhatsApp: read 1:1 and group chats, return machine-readable transcripts (sized to "since last review" or arbitrary windows), detect contact-to-chat membership, honour a no-read list, and send messages from JSON.

Built to improve on the WhatsApp gateway in [`projects/kit/gateway`](../../kit/gateway), specifically:
- Reads **group chats** (kit deliberately filters them out)
- **No coupling** to kit's contact registry, sync service, or capture pipeline
- **Gap detection + backfill** baked in (kit only reads its in-process buffer)
- **No-read list** as a first-class concept
- Importer for **phone-side `Export Chat` `.txt` files** for true full backfill

---

## 1. Goals

1. Authenticate to WhatsApp once via QR (or pairing code), persist credentials, never re-auth unless explicitly re-linked.
2. Continuously capture every 1:1 and group message in real time while the daemon is running.
3. Plug short outage gaps automatically using Baileys' server-side history backfill.
4. Detect and surface multi-day gaps that require manual phone-export backfill.
5. Expose a stable REST API and a thin CLI for other projects to consume.
6. Emit transcripts in a JSON schema designed for ingestion into Open Brain (or any downstream store).
7. Run reliably as an always-on daemon on a Windows machine, Pi, or VPS.

### Non-goals (v1)

- Sending media (images, voice notes, files) — text only.
- Sending to group chats — outbound v1 is 1:1 only.
- Replying to specific messages, reactions, presence updates, or read receipts.
- Multi-account support — one WhatsApp account per gateway instance.
- Web UI — interaction is REST + CLI only.
- Direct writes to Open Brain — module returns JSON; the caller writes to Open Brain.

---

## 2. Architecture

```
┌──────────────────┐   REST/CLI    ┌──────────────────────────────┐
│ Caller projects  │ ─────────────►│  WhatsApp Integration Daemon │
│ (openbrain etc.) │               │  ┌────────────────────────┐  │
└──────────────────┘               │  │ REST API (Express)     │  │
                                   │  ├────────────────────────┤  │
                                   │  │ Read service           │  │
                                   │  │ Send service           │  │
                                   │  │ Membership service     │  │
                                   │  │ No-read list           │  │
                                   │  │ Gap detector           │  │
                                   │  │ History backfill       │  │
                                   │  │ Phone-export importer  │  │
                                   │  └────────┬───────┬───────┘  │
                                   │           │       │          │
                                   │  ┌────────▼───┐ ┌─▼────────┐ │
                                   │  │ MessageStore│ │ State DB │ │
                                   │  │ (Baileys)   │ │ (SQLite) │ │
                                   │  └────────┬───┘ └──────────┘ │
                                   │           │                  │
                                   │  ┌────────▼─────────────┐    │
                                   │  │ Baileys WA Connection│    │
                                   │  └────────┬─────────────┘    │
                                   └───────────┼──────────────────┘
                                               │ WhatsApp Web protocol
                                               ▼
                                       ┌─────────────┐
                                       │ WhatsApp    │
                                       │ servers     │
                                       └─────────────┘
```

### Components

| Component | Responsibility |
|---|---|
| **WhatsApp Connection** | Wraps `@whiskeysockets/baileys`. QR/pairing-code auth, persistent auth state, reconnection with backoff, emits `message:received` / `message:sent`. Lifted from kit/gateway with group-message filter removed. |
| **MessageStore** | Append-only local cache of every message seen. Indexed by chat JID. Persisted to disk so a restart doesn't lose buffered history. |
| **State DB (SQLite)** | Per-chat watermarks (`last_reviewed_at`), no-read list, contact↔chat membership cache, gap log. Single file: `state.db`. |
| **Read service** | Returns transcripts: since-watermark, since-timestamp, or full. Filters out no-read chats. Updates watermark when caller acknowledges. |
| **Send service** | Validates JSON payload, sends via Baileys, returns message ID + delivery status. |
| **Membership service** | "Which chats is contact X on?" — answered from local cache; cache refreshable via endpoint. |
| **No-read list** | Persistent list of JIDs (or contact identifiers that resolve to JIDs) that the read service silently excludes from all output and the message router never persists. |
| **Gap detector** | On daemon startup and on reconnect, computes downtime window. Triggers history backfill, logs any unfilled gaps to `gaps` table, exposes them in transcript responses. |
| **History backfill** | Calls Baileys' `fetchMessageHistory` paginated to pull older messages from WA servers (covers minutes-to-weeks gaps depending on WA's retention). |
| **Phone-export importer** | Parses WhatsApp's `Export Chat` `.txt` files, deduplicates against `MessageStore` by timestamp+body+sender, fills gaps that exceed server retention. |
| **REST API** | Express server on configurable port (default 3100). All functionality exposed here. |
| **CLI** | Thin Node.js client that calls the local REST API. Distributed as a single `wa` binary via `npm link` or bundled. |

---

## 3. Functional requirements

### FR-1: One-time QR authentication

- On first start, daemon generates QR code (printed to terminal + exposed at `GET /api/auth/qr` as PNG/SVG).
- Pairing-code fallback if `WHATSAPP_PHONE` env var set (matches kit's behaviour).
- Auth state persisted to `auth_state/` directory; subsequent starts connect silently.
- `GET /api/auth/status` reports `connected | qr_ready | connecting | disconnected | logged_out`.
- `DELETE /api/auth` wipes auth state (forces re-link on next start).

### FR-2: Read 1:1 and group chats

- Live message capture for **every** chat (1:1 and group), not just a tracked-contacts subset.
- Group messages preserve sender identity (`participantJid` and resolved display name where available).
- All messages stored in `MessageStore` with chat JID, sender, timestamp, body, message ID, type (text/media-with-caption/system).

### FR-3: Machine-readable transcripts

Standard transcript JSON schema returned from all read endpoints:

```json
{
  "chat": {
    "jid": "447700900123@s.whatsapp.net",
    "type": "individual",
    "displayName": "Alice Smith",
    "isGroup": false
  },
  "window": {
    "from": "2026-04-12T09:00:00Z",
    "to":   "2026-04-19T11:34:21Z",
    "reason": "since_last_review"
  },
  "messages": [
    {
      "id": "3EB0...",
      "timestamp": "2026-04-12T09:01:14Z",
      "fromMe": false,
      "sender": { "jid": "447700900123@s.whatsapp.net", "displayName": "Alice Smith" },
      "type": "text",
      "body": "are you free Thursday?",
      "quotedMessageId": null
    }
  ],
  "gaps": [
    { "from": "2026-04-13T22:00:00Z", "to": "2026-04-14T07:30:00Z", "reason": "gateway_offline", "backfillAttempted": true, "backfillSucceeded": false }
  ],
  "watermark": { "previous": "2026-04-12T09:00:00Z", "new": "2026-04-19T11:34:21Z" }
}
```

### FR-4: Last-reviewed watermarks (incremental reads)

- `GET /api/chats/{jid}/messages?mode=since_last_review` — returns everything new since the stored watermark for that chat. Watermark **does not auto-advance** on read.
- `POST /api/chats/{jid}/ack` with `{ "watermark": "2026-04-19T11:34:21Z" }` advances the watermark. Caller is responsible for acking only after successful downstream write (avoids data loss on caller crash).
- Watermarks stored per-chat in SQLite `chat_watermarks` table.

### FR-5: Full and ranged transcripts

- `GET /api/chats/{jid}/messages?mode=full` — entire local store for the chat.
- `GET /api/chats/{jid}/messages?from=2026-04-01T00:00:00Z` — everything since timestamp.
- `GET /api/chats/{jid}/messages?from=...&to=...` — bounded window.
- All modes use the same response schema; `window.reason` reflects the mode.

### FR-6: Contact→chat membership

- `GET /api/contacts/{identifier}/chats` — returns list of chats the contact appears in.
- `identifier` accepts: `+E164`, JID, `@lid`, or display name (best-effort).
- Backed by a local cache table; refreshed in three ways:
  1. Live — every incoming group message updates the membership table.
  2. On-demand — `POST /api/contacts/refresh` walks group metadata via Baileys' `groupFetchAllParticipating`.
  3. Scheduled — once every 24h while connected.
- Response includes `lastVerifiedAt` per chat so caller knows freshness.

### FR-7: No-read list

- Configurable list of JIDs (and `+E164` / display names that resolve to JIDs) that:
  - Never appear in transcripts.
  - Never have their messages persisted to `MessageStore` (incoming messages dropped at the router).
  - Are excluded from membership queries.
- Endpoints:
  - `GET /api/no-read` — list current entries.
  - `POST /api/no-read` `{ "identifier": "..." }` — add. Resolves identifier to JID and returns the resolved value.
  - `DELETE /api/no-read/{jid}` — remove.
- Stored in SQLite `no_read_list` table.
- **Adding a JID to the no-read list always purges existing history for that JID** from `MessageStore` (and any cached membership rows). This is destructive and irreversible — removing the JID from the no-read list later does not restore the deleted messages. Future capture is also suppressed.

### FR-8: Send messages from JSON

- `POST /api/send` accepts:

```json
{
  "messages": [
    { "to": "+447700900123", "text": "Hi Alice — are you free Thursday?" },
    { "to": "+447700900124", "text": "Reminder: standup at 10:00" }
  ]
}
```

- Response:

```json
{
  "results": [
    { "to": "+447700900123", "status": "sent",   "messageId": "3EB0..." },
    { "to": "+447700900124", "status": "failed", "error": "recipient_not_on_whatsapp" }
  ]
}
```

- v1: 1:1 text only. Sending to a group JID returns `unsupported_recipient_type`.
- Each send is sequential with a small delay (200ms) between messages to avoid spam-detection.

### FR-9: Gap detection and backfill (recommendation from review)

- On startup, daemon compares stored "last seen" timestamp to now. If gap > 60s, marks a gap row in `gaps`.
- Immediately calls `fetchMessageHistory` on each chat, paginated, until either: (a) reaches the gap floor, or (b) hits a configurable cap (default 500 messages per chat per backfill).
- For every gap row: sets `backfill_attempted=true`. If after backfill the local store still has no messages within the gap window for a chat, leaves `backfill_succeeded=false`. (Note: "no messages" doesn't prove a gap is unfilled — a quiet chat looks the same — but the flag tells callers "we tried.")
- Gaps surface in transcript responses (FR-3 schema) so callers can warn / prompt for export.
- `GET /api/gaps` — list all known gaps.
- `POST /api/gaps/{id}/resolve` — manually mark a gap as resolved (e.g. after phone-export import).

### FR-12: Contact context scrape

- `POST /api/contacts/{identifier}/scrape-context` — fetches complete chat history for all chats a given contact belongs to.
- Accepts `{ "maxMessagesPerChat": 500, "since": "<ISO timestamp>" }` (both optional).
- First resolves the contact to a JID, then queries the membership cache (triggering a refresh if empty), then issues paginated `fetchMessageHistory` calls for each chat.
- Returns per-chat backfill counts and a total.
- CLI: `wa contacts scrape-context <identifier>`.

### FR-13: WhatsApp ZIP export ingestion

- Accepts the ZIP file produced by WhatsApp's built-in "Export Chat" feature (Android/iOS), which contains a `_chat.txt` transcript and optional media attachments.
- **Manual mode:** `POST /api/import/zip-export` (multipart upload, optional `chatJid` field). Extracts the ZIP, locates the `.txt` file, and delegates to the existing phone-export parser.
- **Automatic mode:** The daemon listens for incoming documents from itself (`fromMe=true`) with a ZIP mime type and a filename matching `WhatsApp Chat*.zip`. On detection, downloads the attachment via Baileys and runs it through the ZIP importer automatically. Disable with `DISABLE_AUTO_ZIP_IMPORT=true`.
- Both modes return `{ "imported", "duplicates", "gapsResolved", "textFile", "attachmentsIgnored" }`.
- CLI: `wa import-zip <path> [--jid <jid>]`.

### FR-10: Phone-export importer

- `POST /api/import/phone-export` (multipart upload) accepts a WhatsApp `Export Chat` `.txt` file.
- Parses standard format: `[DD/MM/YYYY, HH:MM:SS] Sender: message`.
- Caller specifies target JID (or daemon infers from file header where possible).
- Deduplicates against `MessageStore` by `(timestamp, sender, body)` triple.
- Returns: `{ "imported": 432, "duplicates": 1207, "gapsResolved": [3, 7] }`.

### FR-11: CLI

Thin wrapper over the REST API. Examples:

```bash
wa auth status
wa auth qr                                  # prints QR / pairing code

wa chats list                               # all chats with last activity
wa chats list --unread                      # chats with messages newer than watermark

wa read <jid>                               # since last review (default)
wa read <jid> --full
wa read <jid> --from 2026-04-01
wa read <jid> --from 2026-04-01 --to 2026-04-15
wa read <jid> --json > transcript.json      # default output is JSON

wa ack <jid> --watermark 2026-04-19T11:34:21Z

wa contacts chats +447700900123             # which chats is this contact on
wa contacts refresh

wa no-read list
wa no-read add +447700900124
wa no-read remove +447700900124

wa send --to +447700900123 --text "Hello"
wa send --file messages.json                # bulk from JSON file

wa gaps list
wa import-export ./WhatsApp_Chat_with_Alice.txt --jid 447700900123@s.whatsapp.net
```

CLI auto-detects daemon at `http://localhost:3100` (or `WA_GATEWAY_URL` env var).

---

## 4. Non-functional requirements

| Concern | Requirement |
|---|---|
| **Runtime** | Node.js ≥ 20, TypeScript |
| **Library** | `@whiskeysockets/baileys` (latest stable) |
| **Storage** | SQLite (`better-sqlite3`) for state DB; JSON file for `MessageStore` (port from kit, optionally migrate to SQLite later) |
| **Process model** | Always-on daemon. Restart handled by external service manager (systemd / NSSM / pm2). |
| **Auth state** | Persisted to `auth_state/` (Baileys multi-file format) |
| **Logging** | `pino` JSON logs to stdout; log level via `LOG_LEVEL` env var |
| **Configuration** | `.env` file: `PORT`, `AUTH_STATE_PATH`, `STATE_DB_PATH`, `MESSAGE_STORE_PATH`, `WHATSAPP_PHONE` (optional), `LOG_LEVEL`, `BACKFILL_MAX_MESSAGES_PER_CHAT`, `MEMBERSHIP_REFRESH_HOURS` |
| **Security** | REST API binds to `127.0.0.1` by default. Tunnel via Tailscale/Cloudflare for remote access. Optional `WA_GATEWAY_TOKEN` env var enables `Authorization: Bearer` requirement. |
| **Performance** | Read endpoints must return < 500ms for ≤ 1000 messages. SQLite indexed on `chat_jid + timestamp`. |
| **Reliability** | Reconnect with exponential backoff (cap 60s). Auto-restart-friendly: all state on disk; clean shutdown on SIGINT/SIGTERM. |
| **Compliance** | This uses an unofficial WhatsApp protocol implementation (Baileys). Personal-volume use historically tolerated; formally violates Meta ToS. Caller projects should treat ban risk as non-zero. |

---

## 5. Data model (SQLite)

```sql
-- Per-chat read watermarks
CREATE TABLE chat_watermarks (
  chat_jid TEXT PRIMARY KEY,
  last_reviewed_at INTEGER NOT NULL,  -- epoch ms
  updated_at INTEGER NOT NULL
);

-- No-read list
CREATE TABLE no_read_list (
  jid TEXT PRIMARY KEY,
  identifier_input TEXT,              -- what the user originally provided
  added_at INTEGER NOT NULL
);

-- Contact → chat membership cache
CREATE TABLE chat_members (
  chat_jid TEXT NOT NULL,
  participant_jid TEXT NOT NULL,
  display_name TEXT,
  last_verified_at INTEGER NOT NULL,
  PRIMARY KEY (chat_jid, participant_jid)
);
CREATE INDEX idx_members_participant ON chat_members(participant_jid);

-- Chat metadata snapshot
CREATE TABLE chats (
  jid TEXT PRIMARY KEY,
  display_name TEXT,
  is_group INTEGER NOT NULL,
  last_activity_at INTEGER,
  last_seen_by_daemon_at INTEGER     -- for gap detection
);

-- Gap log
CREATE TABLE gaps (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_jid TEXT,                     -- NULL for daemon-wide gaps
  from_ts INTEGER NOT NULL,
  to_ts INTEGER NOT NULL,
  reason TEXT NOT NULL,              -- gateway_offline | reconnect_history_loss
  backfill_attempted INTEGER NOT NULL DEFAULT 0,
  backfill_succeeded INTEGER NOT NULL DEFAULT 0,
  resolved_at INTEGER,
  notes TEXT
);
```

`MessageStore` itself remains JSON-on-disk (lifted from kit's `message-store.ts`) for v1 to keep the migration risk low. A future task can move it into SQLite if the JSON file grows uncomfortably large.

---

## 6. REST API summary

| Method | Path | Description |
|---|---|---|
| GET | `/api/status` | Daemon status (connection, uptime, store stats) |
| GET | `/api/auth/status` | Auth state |
| GET | `/api/auth/qr` | QR code (PNG) — only valid in `qr_ready` state |
| DELETE | `/api/auth` | Wipe auth state |
| GET | `/api/chats` | List all chats with metadata |
| GET | `/api/chats/{jid}/messages` | Read messages (modes: `since_last_review` (default), `full`, `from`/`to`) |
| POST | `/api/chats/{jid}/ack` | Advance watermark |
| GET | `/api/contacts/{identifier}/chats` | Which chats a contact is on |
| POST | `/api/contacts/{identifier}/scrape-context` | Fetch full history for all chats a contact belongs to |
| POST | `/api/contacts/refresh` | Refresh group-membership cache |
| GET | `/api/no-read` | List no-read entries |
| POST | `/api/no-read` | Add to no-read list |
| DELETE | `/api/no-read/{jid}` | Remove from no-read list |
| POST | `/api/send` | Send 1:1 text message(s) |
| GET | `/api/gaps` | List known gaps |
| POST | `/api/gaps/{id}/resolve` | Mark gap resolved |
| POST | `/api/import/phone-export` | Import phone-side `Export Chat` .txt |
| POST | `/api/import/zip-export` | Import WhatsApp export ZIP (containing .txt + optional media) |

---

## 7. Items using defaults — please confirm during review

| # | Decision | Default chosen | Override? |
|---|---|---|---|
| 4 | Storage | SQLite (`better-sqlite3`) for state, JSON for message store | y/n |
| 5 | Open Brain integration | Module returns JSON; caller writes to Open Brain | y/n |
| 6 | Group membership | Local cache, live-updated + 24h refresh + on-demand endpoint | y/n |
| 7 | Send schema | Text-only, 1:1 only, JSON array shape per FR-8 | y/n |
| — | Default REST port | 3100 | y/n |
| — | Hosting target | Your Windows machine initially; designed to be portable to Pi/VPS | y/n |

---

## 8. Implementation plan (Ralph-loop compatible)

The Ralph-loop plugin runs Claude in a `while-true` against a single prompt until a completion promise is emitted. To work well with that model, the plan is broken into **phases with binary, test-driven completion criteria**. Each phase has a checkable artifact (a passing test suite). Ralph re-reads its own prior work between iterations, so the prompt explicitly tells it to start each iteration by reviewing what's already on disk.

### Phase 0: Project scaffold

- `package.json` with deps: `@whiskeysockets/baileys`, `express`, `better-sqlite3`, `pino`, `qrcode-terminal`, `qrcode`, `zod`, `dotenv`, `multer`, `vitest`, `tsx`, `typescript`, `@types/*`.
- `tsconfig.json` (strict mode, `module: nodenext`).
- Directory layout:
  ```
  src/
    config.ts
    index.ts                      # daemon entry
    cli.ts                        # CLI entry
    services/
      whatsapp.ts                 # ported from kit, group filter REMOVED
      message-store.ts            # ported from kit
      state-db.ts                 # SQLite wrapper + migrations
      read.ts
      send.ts
      no-read.ts
      membership.ts
      gap-detector.ts
      history-backfill.ts
      phone-export-importer.ts
    routes/
      api.ts
    types.ts
    utils/
      jid.ts                      # E164 ↔ JID, identifier resolution
  test/
    fixtures/
  ```
- Migration script for SQLite schema (FR-§5).
- `.env.example` + `README.md` with setup and run instructions.
- **Done when:** `npm run build` succeeds; `npm test` runs with 0 tests; `npm run dev` boots the daemon and serves `GET /api/status` returning `{ "status": "ok", "connection": "disconnected" }`.

### Phase 1: Auth + connection (FR-1)

- Port `whatsapp.ts` from `kit/gateway/src/services/`; **remove** the `@g.us` filter in `parseMessage`.
- Wire `GET /api/auth/status`, `GET /api/auth/qr`, `DELETE /api/auth`.
- Reconnection logic with exponential backoff (already in kit's version).
- **Tests:**
  - Mock Baileys; verify QR event triggers `qr_ready` status.
  - Verify `DELETE /api/auth` removes `auth_state/` contents.
  - Verify reconnect backoff math.
- **Manual verification:** Author scans QR once, verifies `auth_state/` populated, restarts daemon, confirms silent reconnect.
- **Done when:** Tests pass + manual verification confirmed in a `MANUAL_VERIFICATION.md` checklist file the user updates.

### Phase 2: Message capture (FR-2) + MessageStore

- Port `message-store.ts` from kit (no changes needed — already chat-agnostic).
- Live message handler stores **every** message including groups.
- Resolve sender display name for group messages via `socket.groupMetadata`.
- **Tests:**
  - Inject simulated 1:1 message → assert stored.
  - Inject simulated group message → assert stored with `participantJid`.
  - Restart daemon → assert MessageStore reloads from disk.
- **Done when:** Tests pass.

### Phase 3: SQLite state DB (FR-§5)

- `state-db.ts` exposes typed accessors: `getWatermark`, `setWatermark`, `addNoRead`, `listNoRead`, `removeNoRead`, `upsertChatMember`, `findChatsForParticipant`, `recordGap`, `listGaps`, `resolveGap`.
- Migrations run on startup; schema version table.
- **Tests:** Round-trip every accessor with an in-memory SQLite instance.
- **Done when:** Tests pass.

### Phase 4: Read endpoints (FR-3, FR-4, FR-5)

- `read.ts` builds the standard transcript JSON from MessageStore + watermarks + gaps.
- `GET /api/chats/{jid}/messages?mode=...` and `POST /api/chats/{jid}/ack`.
- Excludes no-read JIDs.
- **Tests:**
  - Snapshot test on transcript JSON shape.
  - `since_last_review` returns only post-watermark messages.
  - `full` returns everything for chat.
  - `from`/`to` window filters correctly.
  - No-read JIDs return `404` or empty (decision: empty with a `policy: "no_read"` field).
  - `ack` advances watermark; subsequent `since_last_review` returns nothing.
- **Done when:** Tests pass.

### Phase 5: No-read list (FR-7)

- CRUD endpoints on `no_read_list` table.
- Identifier resolver (`+E164` / JID / `@lid` / display name → JID).
- Router-level filter that drops messages destined for no-read JIDs **before** they reach MessageStore.
- **Tests:**
  - Add by E164; verify resolved JID stored.
  - Add by JID; verify echoed back.
  - Incoming message for no-read JID is dropped (asserted against MessageStore).
  - Adding a JID with pre-existing messages in MessageStore purges those messages.
  - Adding a JID with pre-existing rows in `chat_members` purges those rows.
- **Done when:** Tests pass.

### Phase 6: Send (FR-8)

- `POST /api/send` with bulk array.
- Text-only validation via `zod`.
- Sequential send with 200ms inter-message delay.
- Per-message status in response.
- **Tests:**
  - Single send returns `messageId`.
  - Bulk send returns array preserving order.
  - Group JID returns `unsupported_recipient_type`.
  - Invalid E164 returns `invalid_recipient`.
- **Done when:** Tests pass + manual send to user's own number verified.

### Phase 7: Membership (FR-6)

- Live update on every group message → `chat_members` upsert.
- `POST /api/contacts/refresh` walks `socket.groupFetchAllParticipating`.
- Scheduled refresh every `MEMBERSHIP_REFRESH_HOURS` (default 24).
- `GET /api/contacts/{identifier}/chats` query.
- **Tests:**
  - Group message updates membership table.
  - Refresh endpoint repopulates from mocked `groupFetchAllParticipating`.
  - Query returns chats with `lastVerifiedAt`.
- **Done when:** Tests pass.

### Phase 8: Gap detection + history backfill (FR-9)

- On startup, compute gap from `chats.last_seen_by_daemon_at` to `now`.
- Per-chat `fetchMessageHistory` invocation, paginated.
- Record gap rows; mark `backfill_succeeded` based on whether messages landed in the window.
- Surface gaps in transcript responses.
- `GET /api/gaps`, `POST /api/gaps/{id}/resolve`.
- **Tests:**
  - Simulated downtime → gap row recorded.
  - Mocked `fetchMessageHistory` returns messages → flagged succeeded.
  - Mocked empty response → flagged attempted but not succeeded.
  - Gap surfaces in transcript JSON.
- **Done when:** Tests pass.

### Phase 9: Phone-export importer (FR-10)

- `POST /api/import/phone-export` (multer-backed multipart).
- Parser for `[DD/MM/YYYY, HH:MM:SS] Sender: body` (handle multi-line bodies).
- Dedup against MessageStore by `(timestamp, sender, body)`.
- Auto-resolve gaps that are now fully covered.
- **Tests:**
  - Parse fixture file → expected message count.
  - Re-import same file → 100% duplicates.
  - Import covering an open gap → gap auto-resolved.
- **Done when:** Tests pass.

### Phase 10: CLI (FR-11)

- `src/cli.ts` using `commander` (or hand-rolled if minimal).
- Each subcommand maps to a single REST call; output is JSON (default) or pretty table (`--pretty`).
- `npm link`-able binary `wa`.
- **Tests:**
  - Snapshot tests on output formatting for each subcommand against a mocked HTTP server.
- **Done when:** Tests pass + manual CLI walk-through documented.

### Phase 11: Production hardening

- Optional `WA_GATEWAY_TOKEN` bearer-auth middleware.
- `127.0.0.1` bind by default; `BIND_ADDRESS` env var to override.
- Graceful shutdown (SIGINT/SIGTERM): flush MessageStore, close SQLite, disconnect Baileys.
- README section on running as a Windows service via NSSM (and Linux systemd unit file as bonus).
- **Tests:**
  - Auth middleware rejects missing/invalid token when configured.
  - Auth middleware allows when not configured.
- **Done when:** Tests pass + README sections written.

### Phase 12: End-to-end smoke test

- Single Vitest spec that:
  1. Spins up daemon against mocked Baileys.
  2. Simulates inbound 1:1 + group messages.
  3. Reads via `/api/chats/{jid}/messages` and asserts schema.
  4. Acks watermark, simulates more messages, reads again, asserts only new returned.
  5. Adds JID to no-read, simulates message, asserts dropped.
  6. Sends a message, asserts socket called with correct args.
  7. Imports a phone-export fixture, asserts gap resolved.
- **Done when:** This single spec passes.

### Phase 13: Contact context scraper (FR-12)

New service `src/services/contact-context-scraper.ts` that, given a contact identifier, fetches complete message history across **all** chats they appear in.

**Endpoint:** `POST /api/contacts/{identifier}/scrape-context`

Request body (all fields optional):
```json
{ "maxMessagesPerChat": 500, "since": "2026-01-01T00:00:00Z" }
```

Response:
```json
{
  "contactJid": "447700900123@s.whatsapp.net",
  "chats": [
    { "jid": "120363..@g.us", "displayName": "Family Group", "type": "group", "messagesBackfilled": 42 },
    { "jid": "447700900123@s.whatsapp.net", "displayName": "Alice Smith", "type": "individual", "messagesBackfilled": 7 }
  ],
  "totalMessagesBackfilled": 49
}
```

**Service logic:**
1. Resolve identifier → JID via `jid.ts`.
2. Call `MembershipService.getChatsForContact(identifier)` to get all chats.
3. If the membership result is empty, call `MembershipService.refresh()` first then retry (contact might not have sent a group message yet in this session).
4. For each chat, call `socket.fetchMessageHistory(jid, cursor, count)` paginated until either: (a) messages prior to `since` are reached, or (b) `maxMessagesPerChat` is reached.
5. Buffer fetched messages into `MessageStore`.
6. Return per-chat stats.

**CLI:**
```bash
wa contacts scrape-context +447700900123
wa contacts scrape-context +447700900123 --since 2026-01-01 --max 1000
```

**Tests:**
- Mock membership service returning two chats; mock socket `fetchMessageHistory`; assert both chats are fetched and stats returned correctly.
- Zero chats returned from membership → triggers refresh → retry path exercised.
- `since` filter stops pagination at the right cursor.
- **Done when:** Tests pass.

### Phase 14: ZIP export ingestion (FR-13)

Extends the phone-export importer to handle WhatsApp's exported ZIP file format. WhatsApp's "Export Chat" on Android/iOS produces a `.zip` containing a `_chat.txt` (or `WhatsApp Chat with X.txt`) and optionally attached media files.

**Two ingestion modes:**

#### 14a — Manual upload endpoint

`POST /api/import/zip-export` (multipart, field name `file`, optional field `chatJid`)

The endpoint:
1. Receives the ZIP buffer via multer.
2. Extracts to a temp directory using `adm-zip` (pure-JS, Windows-safe).
3. Finds the first `.txt` file in the ZIP (the chat transcript).
4. If `chatJid` not provided, attempts to infer from the filename (`WhatsApp Chat with X.txt` → lookup in `StateDb.chats`).
5. Calls existing `importPhoneExport(text, chatJid, store, db)`.
6. Cleans up temp directory.
7. Returns:
```json
{ "imported": 432, "duplicates": 1207, "gapsResolved": [3, 7], "textFile": "WhatsApp Chat with Alice.txt", "attachmentsIgnored": 12 }
```

#### 14b — Automatic detection of self-sent ZIPs

In `WhatsAppConnection`, on `messages.upsert`, detect messages where:
- `fromMe === true`
- `message.documentMessage` (or `message.documentWithCaptionMessage`) is present
- `mimetype` is `application/zip` or `application/x-zip-compressed`
- `fileName` matches `/whatsapp chat/i`

When detected:
1. Download the attachment via Baileys `downloadMediaMessage(msg)`.
2. Pass the buffer to the ZIP importer service.
3. Log the import result (no REST response needed — it's background processing).
4. Emit a `zip-import:complete` event so callers can hook in.

Automatic detection can be disabled via `DISABLE_AUTO_ZIP_IMPORT=true` env var (default: enabled).

**New dependency:** `adm-zip` — add to `package.json`.

**New service:** `src/services/zip-export-importer.ts`

```ts
export async function importZipExport(
  zipBuffer: Buffer,
  chatJid: string | undefined,
  store: MessageStore,
  db: StateDb
): Promise<ZipImportResult>
```

**CLI:**
```bash
wa import-zip ./WhatsApp_Chat_with_Alice.zip
wa import-zip ./export.zip --jid 447700900123@s.whatsapp.net
```

**Tests:**
- Build a minimal fixture ZIP in the test containing a known `.txt`; assert import result matches expected counts.
- Re-import same ZIP → 100% duplicates.
- ZIP with no `.txt` file → error response.
- Auto-detect: inject a simulated self-sent document message with ZIP mime type → assert importer called.
- `DISABLE_AUTO_ZIP_IMPORT=true` → auto-detect suppressed.
- **Done when:** Tests pass.

### Completion promise

When all phase test suites pass (including Phases 13 and 14) and Phase 12's e2e spec passes, the agent emits:

```
<promise>WHATSAPP_INTEGRATION_COMPLETE</promise>
```

### Ralph-loop invocation

```bash
/ralph-loop:ralph-loop "$(cat docs/ralph-prompt.md)" \
  --completion-promise "WHATSAPP_INTEGRATION_COMPLETE" \
  --max-iterations 60
```

---

## 9. Test plan

### Unit tests (Vitest)

Per-phase tests as listed above. Coverage target: ≥ 80% on `src/services/` and `src/utils/`. `src/index.ts` and routes are covered by integration tests.

### Integration tests

- One spec per route file in `src/routes/api.ts` using `supertest` against an in-process Express app with mocked services.
- `whatsapp.ts` integration test uses a stubbed Baileys socket (event-emitter facade).

### End-to-end test

Phase 12 spec — single happy-path through every major feature.

### Manual verification checklist

`MANUAL_VERIFICATION.md` documents the steps that can't be automated:

- [ ] First-run QR scan completes; `auth_state/` populated.
- [ ] Daemon restart reconnects without re-scanning.
- [ ] Inbound 1:1 message captured (verify via `wa read`).
- [ ] Inbound group message captured with sender resolved.
- [ ] Outbound `wa send` delivers visibly on phone.
- [ ] No-read entry suppresses both transcript and storage.
- [ ] Phone-export `.txt` file imports and resolves a gap.
- [ ] Daemon survives 24h uptime test on host machine.

---

## 10. Open questions for review

1. Items in §7 — confirm or override defaults.
2. Should the daemon's MessageStore stay JSON-on-disk (kit's approach), or move into SQLite straight away? **Default: JSON for v1, SQLite migration as a Phase 13 if needed.**
3. Should media (images, voice, files) be persisted to disk for transcripts even though we only emit text bodies for v1? **Default: no — v1 ignores media bodies entirely. Media support is its own future spec.**
4. Should `wa send` support a `dryRun: true` flag that validates and resolves recipients but doesn't send? **Default: yes, low cost — include in Phase 6.**
5. Should the gateway expose Server-Sent Events or WebSocket so callers can react to messages in real time, or is poll-via-`since_last_review` enough? **Default: polling for v1; SSE deferred to v2.**

---

## Next step

**Pause for user review of this spec.** Once approved (with any overrides on §7 / §10), I will:

1. Create `docs/ralph-prompt.md` with the iteration-friendly prompt body.
2. Initialise the project (Phase 0 only) so Ralph has a working scaffold to iterate on.
3. Hand off to `/ralph-loop:ralph-loop` to execute Phases 1–12.
