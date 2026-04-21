# Claude WhatsApp Integration

Standalone TypeScript daemon that lets coding projects integrate with WhatsApp: read 1:1 and group chats, return machine-readable transcripts, send messages, with gap-detection and phone-export backfill. Built on `@whiskeysockets/baileys`.

Full spec: [docs/claude_whatsapp_integration.md](docs/claude_whatsapp_integration.md).

## Status

Phases 0-12 complete (102 tests passing). Phases 13-14 planned — build them via the [ralph-loop plugin](https://github.com/anthropics/claude-plugins-official/tree/main/plugins/ralph-loop).

| Phase | Feature | Status |
|---|---|---|
| 0-12 | Core integration (auth, capture, transcripts, send, membership, gaps, CLI, e2e) | ✅ Complete |
| 13 | Contact context scraper — fetch full history for all chats a contact belongs to | 🔲 Planned |
| 14 | ZIP export ingestion — manual upload + automatic self-sent ZIP detection | 🔲 Planned |

## Setup

Requires Node.js ≥ 20.

```bash
npm install
cp .env.example .env
# edit .env if you need to change defaults
npm run dev
```

`GET http://localhost:3100/api/status` should return `{ "status": "ok", ... }`.

## Building Phases 13-14 (ralph-loop)

```bash
/ralph-loop:ralph-loop "$(cat docs/ralph-prompt.md)" \
  --completion-promise "WHATSAPP_INTEGRATION_COMPLETE" \
  --max-iterations 60
```

Ralph will pick up from `RESUME_NOTES.md` (all prior phases are complete) and build Phases 13 and 14. If interrupted, re-run the same command and ralph resumes from where it left off.

### Phase 13: Contact context scraper

Given a contact identifier (`+E164`, JID, or display name), fetches the complete message history across **every chat** that contact belongs to. This gives full conversational context rather than requiring you to know which specific chat to query.

**New endpoint:** `POST /api/contacts/{identifier}/scrape-context`
```json
// Request
{ "maxMessagesPerChat": 500, "since": "2026-01-01T00:00:00Z" }

// Response
{
  "contactJid": "447700900123@s.whatsapp.net",
  "chats": [
    { "jid": "120363..@g.us", "displayName": "Family Group", "type": "group", "messagesBackfilled": 42 },
    { "jid": "447700900123@s.whatsapp.net", "displayName": "Alice", "type": "individual", "messagesBackfilled": 7 }
  ],
  "totalMessagesBackfilled": 49
}
```

**New CLI:** `wa contacts scrape-context +447700900123 [--since 2026-01-01] [--max 1000]`

**New service:** `src/services/contact-context-scraper.ts`

### Phase 14: ZIP export ingestion

Accepts the ZIP file produced by WhatsApp's built-in "Export Chat" feature (Android/iOS). Contains a `.txt` transcript and optional media attachments. Hands the `.txt` file to the existing phone-export parser.

**Two modes:**

**Manual upload** — `POST /api/import/zip-export` (multipart, optional `chatJid` field):
```json
{ "imported": 432, "duplicates": 1207, "gapsResolved": [3, 7], "textFile": "WhatsApp Chat with Alice.txt", "attachmentsIgnored": 12 }
```

**Automatic detection** — when you send the export ZIP to yourself via WhatsApp, the daemon detects the self-sent document, downloads it, and ingests it automatically. Disable with `DISABLE_AUTO_ZIP_IMPORT=true`.

**New CLI:** `wa import-zip ./WhatsApp_Chat_with_Alice.zip [--jid <jid>]`

**New service:** `src/services/zip-export-importer.ts` (uses `adm-zip`)

## Commands

| Command | Description |
|---|---|
| `npm run dev` | Start daemon with hot-reload |
| `npm start` | Start daemon (production) |
| `npm run build` | Compile TypeScript to `dist/` |
| `npm test` | Run Vitest tests |
| `npm run test:watch` | Vitest watch mode |
| `npm run test:coverage` | Vitest with coverage |
| `npm run lint` | Type-check (no emit) |
| `npm run cli -- <args>` | Run the CLI in dev mode |

## Project layout

```
src/
  config.ts                       Env-var parsing
  index.ts                        Daemon entry
  cli.ts                          CLI entry
  routes/
    api.ts                        Express router
  services/
    whatsapp.ts                   Baileys connection (Phase 1)
    message-store.ts              Persistent message buffer (Phase 2)
    state-db.ts                   SQLite wrapper (Phase 3)
    read.ts                       Transcript builder (Phase 4)
    no-read.ts                    No-read list (Phase 5)
    send.ts                       Outbound messages (Phase 6)
    membership.ts                 Contact↔chat cache (Phase 7)
    gap-detector.ts               Downtime tracking (Phase 8)
    history-backfill.ts           Server-side backfill (Phase 8)
    phone-export-importer.ts      .txt importer (Phase 9)
    contact-context-scraper.ts    Full history for all contact chats (Phase 13)
    zip-export-importer.ts        WhatsApp ZIP export ingestion (Phase 14)
  types.ts                        Shared TypeScript types
  utils/
    jid.ts                        E164 / JID / @lid helpers

test/
  fixtures/                       Test data
docs/
  claude_whatsapp_integration.md  Full spec
  ralph-prompt.md                 Ralph-loop operative prompt
```

## Compliance note

Baileys uses an unofficial WhatsApp Web protocol. Personal-volume use has historically been tolerated but formally violates Meta's Terms of Service. Treat ban risk as non-zero.
