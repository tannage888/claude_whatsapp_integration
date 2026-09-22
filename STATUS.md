# Status — Claude WhatsApp Integration

**As of:** 2026-09-22
**Stage:** `done` — running in production under pm2

## What's running

All 15 implementation phases complete, plus contact context scraping (Phase 13),
ZIP export ingestion (Phase 14), `GET /api/groups`, @lid identity resolution,
full-history sync on pairing, and the gap detection/recovery work below.

**226 tests, zero TypeScript errors.**

Live under pm2 as `kit-daemon` on `:3142`, alongside Kit's `kit-gateway` on
`:3141`.

## Process management — settled

pm2 is the process manager. An earlier attempt to register an NSSM service or a
standalone Task Scheduler entry is **abandoned, not outstanding** — the notes
below used to describe it as blocked on an elevated shell, which was stale.

Auto-start on boot is in place and verified:

- `start-kit-pm2.vbs` in the user Startup folder
- Scheduled tasks `KitGateway` and `WhatsAppDaemon` (note: no space in the name)
- `~/.pm2/dump.pm2` saved

Verified 2026-09-22: machine booted 08:01, daemon was up and connected by 08:06
without intervention.

## Live capture — enabled 2026-09-22

`WA_INCOMING_HOOK_URL=http://127.0.0.1:3141/api/incoming-message` is now set in
`.env`. Until today it was unset, so the hook block in `src/index.ts` never ran
and Kit's `MessageRouter` was driven only by the 3-hourly sweep. Live capture
now fires on each inbound message.

## Gap detection and recovery

Four fixes, merged in [#4](https://github.com/tannage888/claude_whatsapp_integration/pull/4)
and pending in [#5](https://github.com/tannage888/claude_whatsapp_integration/pull/5):

1. **Session health** — a broken Signal session made a chat indistinguishable
   from a quiet one; CIPHERTEXT stubs were discarded in silence. One contact
   lost eight weeks of conversation that way. Now detected and the session
   deleted so the next message renegotiates.
2. **History fetch contract** — `fetchMessageHistory` takes
   `(count, oldestMsgKey, oldestMsgTimestamp)` and returns a request-session id;
   the messages arrive later on `messaging-history.set`. Both call sites passed
   `(chatJid, cursor, pageSize)` and awaited a `{ messages, cursor }` object
   that does not exist. `HistoryFetcher` now correlates the deferred batch.
3. **Quiet-gap classification** — `detect()` cannot tell a chat that lost
   messages from one that stayed silent, so it records a gap for every unwatched
   chat and lets evidence decide. Silent chats never produce evidence, so their
   rows accumulated one per restart until they buried the real losses.
   `settleQuietGaps` closes them once history is complete, recording absence of
   evidence rather than a recovery.
4. **Running at all** — the review hung off `messaging-history.set`, which only
   fires on the initial sync at pairing. On an ordinary restart no batch arrived
   and neither pass ever ran; both earlier fixes were dead code in production.
   `GapReviewScheduler` now drives it from `connection:open` with a 60s settle
   deadline.

**Verified live, 2026-09-22.** On restart the daemon logged, for the first time
in 28 restarts:

```
🕳️  Gaps detected: 86 (30 already covered)
🕳️  Gaps closed by history sync: 87
🕳️  Gaps closed as quiet (no evidence of missed traffic): 1473
```

`/api/gaps` went from **1,571 unresolved to 11**, all `decrypt_failure` — real,
unrecovered loss, which is now the entire open set rather than 0.7% of it.

## Known issues (non-blocking)

- `DELETE /api/auth` returns EPERM on Windows while the daemon is running
- Group participants empty in multi-device mode (@lid JIDs filtered by design)
- `detect()` runs on first connect only (`wa.once`), so a mid-session reconnect
  after a long drop records no gap for that window

## What's next

- **Merge [#5](https://github.com/tannage888/claude_whatsapp_integration/pull/5)** —
  the branch is what the daemon actually runs from the working tree, so `main`
  is behind the running code until it lands
