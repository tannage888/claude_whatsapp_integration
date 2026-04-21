# Ralph Loop Prompt — Claude WhatsApp Integration

You are building a standalone TypeScript module that integrates coding projects with WhatsApp via Baileys. The full specification, including all functional requirements, REST endpoints, data model, JSON schemas, and the 15-phase implementation plan, is in `docs/claude_whatsapp_integration.md`. **Read it on every iteration before doing anything else.**

**Current state as of this prompt:** Phases 0-12 are already complete with 102 tests passing. Your job is to build Phases 13 and 14. Do not modify or re-run Phases 0-12 unless their tests have regressed.

You are running inside the ralph-loop plugin. The same prompt is fed back to you between iterations. All your prior work persists on disk. Use that.

---

## On every iteration, do this in order

1. **Read `docs/claude_whatsapp_integration.md`** end-to-end. The spec is the source of truth.
2. **Read `RESUME_NOTES.md`** in the project root. This is your scratchpad written by the previous iteration. If it doesn't exist yet, you are on iteration 1.
3. **Run `npm test`** and capture the output. Phases 1+ require all tests green.
4. **Run `npx tsc --noEmit`** to check for type errors. Must pass.
5. **Identify the current phase** by checking which phases have completion criteria already met (tests exist and pass) and which is the next unbuilt phase.
6. **Do work on exactly the current phase.** Do not skip ahead. Do not refactor previous phases unless their tests are failing.
7. **Update `RESUME_NOTES.md`** at the end of your iteration with:
   - Current phase number and name
   - What you did this iteration
   - Test status (green/red, with failing test names if red)
   - What the next iteration should focus on
8. **Check completion** against the 95%-certainty criteria below. Emit the completion promise only when those are met.

---

## The 15 phases (summary — full detail in spec §8)

| Phase | Name | Done when |
|---|---|---|
| 0 | Project scaffold | `npm run build` and `npm test` succeed; `GET /api/status` returns ok |
| 1 | Auth + connection | QR/pairing-code auth working, reconnect tested, `auth_state/` persists |
| 2 | Message capture + MessageStore | Live capture of 1:1 and group messages, persisted, restart-survives |
| 3 | SQLite state DB | Schema migrations run, all accessors round-trip tested |
| 4 | Read endpoints | `since_last_review` / `full` / `from`/`to` / ack flow, no-read filter |
| 5 | No-read list | CRUD + identifier resolver + always-purge-on-add |
| 6 | Send | `POST /api/send` text-only bulk with per-message status |
| 7 | Membership | Live update + on-demand refresh + scheduled refresh + query endpoint |
| 8 | Gap detection + backfill | Gap rows recorded, `fetchMessageHistory` invoked, gaps surface in transcripts |
| 9 | Phone-export importer | Parse + dedupe + auto-resolve covered gaps |
| 10 | CLI | Each subcommand maps to REST call; snapshot tests pass |
| 11 | Production hardening | Bearer token middleware, 127.0.0.1 bind, graceful shutdown, README service-install sections |
| 12 | End-to-end smoke test | Single Vitest spec exercising every major feature |
| 13 | Contact context scraper | `POST /api/contacts/{identifier}/scrape-context` fetches full history for all chats contact belongs to; `wa contacts scrape-context` CLI; tests pass |
| 14 | ZIP export ingestion | Manual `POST /api/import/zip-export` endpoint + automatic detection of self-sent WhatsApp export ZIPs; `wa import-zip` CLI; tests pass |

For each phase, the spec (§8) lists exact sub-tasks and required tests. Follow them precisely.

---

## Critical rules

- **Do not emit `<promise>WHATSAPP_INTEGRATION_COMPLETE</promise>` until you have ≥95% certainty that Phases 13 and 14 work as specified** (see "Stop conditions" below for the checklist). The completion promise is an honest signal, not an escape hatch — do not fake it to end the loop.
- **Stay strictly on the current phase.** If a previous phase's tests are red, fix them first before advancing. If a future phase looks easy, ignore it — phase order matters because later phases depend on earlier ones.
- **Tests are the contract.** Every phase's "Done when" criterion is a green test suite. If you've written code but not tests, you are not done with the phase. If you have tests but they don't actually exercise the requirement, you are not done with the phase.
- **Use the kit gateway as a reference.** [`C:/Users/seang/OneDrive/Documents/ClaudeWork/projects/kit/gateway/src/`](C:/Users/seang/OneDrive/Documents/ClaudeWork/projects/kit/gateway/src/) has working code for `whatsapp.ts`, `message-store.ts`, and `history-fetcher.ts`. Port from it where the spec says to. **Remove the `@g.us` group filter** when porting `whatsapp.ts` — this module reads groups.
- **Do not invent features outside the spec.** No backwards-compat shims, no premature abstractions, no media support, no group-send, no SSE. v1 is exactly what the spec lists.
- **Mock Baileys in tests.** Never make real WhatsApp connections in automated tests. Use an event-emitter facade.
- **Write the minimum code that passes the tests for the current phase.** Quality > volume. If you find yourself writing speculative helpers, stop.

---

## Stop conditions (≥95% certainty)

Emit `<promise>WHATSAPP_INTEGRATION_COMPLETE</promise>` when you have **≥95% certainty** that Phases 13 and 14 work as specified. Use this concrete checklist — each box is worth roughly equal weight, and you need all of them checked honestly:

**Hard gates (non-negotiable — missing any of these means <95%):**
1. ☐ `npm test` passes with zero failures (including new Phase 13 + 14 tests).
2. ☐ `npx tsc --noEmit` passes with zero errors.
3. ☐ Phase 12 e2e spec still passes (no regressions in the existing 102 tests).
4. ☐ `src/services/contact-context-scraper.ts` exists with implementation + a unit test file that covers: identifier resolution, empty-membership refresh+retry path, pagination termination, `MessageStore` buffering, and response shape.
5. ☐ `src/services/zip-export-importer.ts` exists with implementation + a unit test file that covers: extracting `.txt` from a fixture ZIP, dedup against `MessageStore`, `chatJid` inference from filename, and the "no `.txt` in ZIP" error path.
6. ☐ `POST /api/contacts/{identifier}/scrape-context` and `POST /api/import/zip-export` are both wired in `src/routes/api.ts` with supertest integration tests.
7. ☐ Auto-detection listener for self-sent WhatsApp export ZIPs is wired in `src/services/whatsapp.ts` (or `src/index.ts`) and has at least one test: fromMe + ZIP mime + matching filename → importer invoked; fromMe=false OR non-ZIP mime → importer NOT invoked; `DISABLE_AUTO_ZIP_IMPORT=true` → listener inactive.
8. ☐ CLI subcommands `wa contacts scrape-context <id>` and `wa import-zip <path>` are added with snapshot tests.

**Soft gates (add confidence — aim to check at least 2):**
9. ☐ You have manually traced the control flow of each new service end-to-end against the spec, reading the code line by line, and found no obvious bugs.
10. ☐ You have verified that `adm-zip` is pinned in `package.json`, installs cleanly, and is actually used by the code (not just imported).
11. ☐ Edge cases you *chose not to handle* are explicitly documented in `RESUME_NOTES.md` under a `## Known limitations` section (e.g. "password-protected ZIPs are not supported").
12. ☐ You wrote down at least one scenario the automated tests *don't* cover, and it's either (a) something only manual verification can hit (e.g. real Baileys media download), or (b) explicitly out of scope.

**Certainty self-assessment:** Before emitting the promise, write a `## Confidence` section in `RESUME_NOTES.md` that states:
- Your self-assessed certainty percentage.
- Which of the 12 boxes above are checked.
- The specific scenarios you're *not* certain about and why you believe they're below the 5% residual-risk threshold.

If your certainty is below 95%, keep iterating. If you're blocked, document the blocker under `## Blockers` in `RESUME_NOTES.md` and continue working on alternative approaches. Do NOT emit the completion promise to escape a blocker.

---

## Output format

End each iteration with a brief status line in your text output:

```
📍 Phase {N} — {short status}. Tests: {X passed, Y failed}. Next: {what to do next iteration}.
```

This shows up in the ralph loop log so the user can see progress at a glance.
