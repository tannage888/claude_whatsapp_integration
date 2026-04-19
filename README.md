# Claude WhatsApp Integration

Standalone TypeScript daemon that lets coding projects integrate with WhatsApp: read 1:1 and group chats, return machine-readable transcripts, send messages, with gap-detection and phone-export backfill. Built on `@whiskeysockets/baileys`.

Full spec: [docs/claude_whatsapp_integration.md](docs/claude_whatsapp_integration.md).

## Status

Phase 0 (scaffold) only. Phases 1-12 to be built via the [ralph-loop plugin](https://github.com/anthropics/claude-plugins-official/tree/main/plugins/ralph-loop).

## Setup

Requires Node.js ≥ 20.

```bash
npm install
cp .env.example .env
# edit .env if you need to change defaults
npm run dev
```

`GET http://localhost:3100/api/status` should return `{ "status": "ok", ... }`.

## Building it out (ralph-loop)

```bash
/ralph-loop "$(cat docs/ralph-prompt.md)" \
  --completion-promise "WHATSAPP_INTEGRATION_COMPLETE" \
  --max-iterations 60
```

Ralph will iteratively build Phases 1-12 against the spec. State lives on disk; if interrupted (usage limits, crash), re-run `/ralph-loop` with the same args and ralph picks up from where it left off via `RESUME_NOTES.md`.

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
