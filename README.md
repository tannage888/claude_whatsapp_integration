# Claude WhatsApp Integration

Standalone TypeScript daemon that lets coding projects integrate with WhatsApp: read 1:1 and group chats, return machine-readable transcripts, send messages, with gap-detection and phone-export backfill. Built on `@whiskeysockets/baileys`.

Full spec: [docs/claude_whatsapp_integration.md](docs/claude_whatsapp_integration.md).

## Status

Phases 0-12 complete (102 tests passing). Phases 13-14 planned — build them via the [ralph-loop plugin](https://github.com/anthropics/claude-plugins-official/tree/main/plugins/ralph-loop).

| Phase | Feature | Status |
|---|---|---|
| 0-12 | Core integration (auth, capture, transcripts, send, membership, gaps, CLI, e2e) | ✅ Complete |
| 13 | Contact context scraper — fetch full history for all chats a contact belongs to | ✅ Complete |
| 14 | ZIP export ingestion — manual upload + automatic self-sent ZIP detection | ✅ Complete |

## Setup

Requires Node.js ≥ 20.

```bash
npm install
cp .env.example .env
# edit .env if you need to change defaults
npm run dev
```

`GET http://localhost:3100/api/status` should return `{ "status": "ok", ... }`.

## Running on Windows startup

To launch the daemon automatically when you log in:

1. Create a `.bat` somewhere stable, e.g. `scripts\start-daemon.bat`:

   ```bat
   @echo off
   setlocal
   set "DAEMON_DIR=%~dp0.."
   set "LOG_DIR=%~dp0..\logs"
   if not exist "%LOG_DIR%" mkdir "%LOG_DIR%"
   cd /d "%DAEMON_DIR%"
   call npm run start >> "%LOG_DIR%\daemon.log" 2>&1
   ```

   Double-click it to test — `GET http://localhost:3100/api/status` should respond, then close the window.

2. Open Task Scheduler (`taskschd.msc`) → **Create Task…**
3. **General**: name it `WhatsApp Daemon`, "Run only when user is logged on".
4. **Triggers** → New → **At log on**, your user.
5. **Actions** → New → **Start a program** → browse to the `.bat`.
6. **Conditions**: untick "Start only if on AC power" if you're on a laptop.
7. **Settings**: tick "Allow task to be run on demand" and "If the task fails, restart every 1 minute" up to 3 attempts.
8. Save, then right-click the task → **Run** to verify.

A `cmd.exe` window will appear at each login. To hide it, point the task action at this one-line VBScript shim instead of the `.bat`:

```vbs
CreateObject("WScript.Shell").Run Chr(34) & "C:\full\path\to\start-daemon.bat" & Chr(34), 0, False
```

Note: if the WhatsApp session in `auth_state/` expires, the daemon will print a fresh QR code at startup. With a hidden window you won't see it — re-run the task in foreground (`schtasks /Run /TN "WhatsApp Daemon"` from a visible terminal, or temporarily switch the action back to the `.bat`) to scan it.

Manage from PowerShell:

```powershell
schtasks /Query /TN "WhatsApp Daemon" /V /FO LIST
schtasks /Run    /TN "WhatsApp Daemon"
schtasks /End    /TN "WhatsApp Daemon"
schtasks /Delete /TN "WhatsApp Daemon" /F
```

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
