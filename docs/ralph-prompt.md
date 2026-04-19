# Ralph Loop Prompt — Claude WhatsApp Integration

You are building a standalone TypeScript module that integrates coding projects with WhatsApp via Baileys. The full specification, including all functional requirements, REST endpoints, data model, JSON schemas, and the 13-phase implementation plan, is in `docs/claude_whatsapp_integration.md`. **Read it on every iteration before doing anything else.**

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
8. **Check completion**: only emit the completion promise when ALL phases (0-12) have green tests AND the e2e spec from Phase 12 passes.

---

## The 13 phases (summary — full detail in spec §8)

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

For each phase, the spec (§8) lists exact sub-tasks and required tests. Follow them precisely.

---

## Critical rules

- **Never emit `<promise>WHATSAPP_INTEGRATION_COMPLETE</promise>` until every phase is done and all tests are green.** If you are stuck, document the blocker in `RESUME_NOTES.md` and continue trying. The completion promise is the only honest signal that the project is done — do not fake it.
- **Stay strictly on the current phase.** If a previous phase's tests are red, fix them first before advancing. If a future phase looks easy, ignore it — phase order matters because later phases depend on earlier ones.
- **Tests are the contract.** Every phase's "Done when" criterion is a green test suite. If you've written code but not tests, you are not done with the phase. If you have tests but they don't actually exercise the requirement, you are not done with the phase.
- **Use the kit gateway as a reference.** [`C:/Users/seang/OneDrive/Documents/ClaudeWork/projects/kit/gateway/src/`](C:/Users/seang/OneDrive/Documents/ClaudeWork/projects/kit/gateway/src/) has working code for `whatsapp.ts`, `message-store.ts`, and `history-fetcher.ts`. Port from it where the spec says to. **Remove the `@g.us` group filter** when porting `whatsapp.ts` — this module reads groups.
- **Do not invent features outside the spec.** No backwards-compat shims, no premature abstractions, no media support, no group-send, no SSE. v1 is exactly what the spec lists.
- **Mock Baileys in tests.** Never make real WhatsApp connections in automated tests. Use an event-emitter facade.
- **Write the minimum code that passes the tests for the current phase.** Quality > volume. If you find yourself writing speculative helpers, stop.

---

## Stop conditions

You may stop the loop in only ONE way: emit `<promise>WHATSAPP_INTEGRATION_COMPLETE</promise>` when, and only when, all of the following are true:

- `npm test` passes with zero failures.
- `npx tsc --noEmit` passes with zero errors.
- The Phase 12 e2e spec exists and passes.
- `RESUME_NOTES.md` documents that all 13 phases are complete.

If you are blocked — a test you cannot make pass, a Baileys API that doesn't behave as the spec assumed, an unresolvable type error — document it precisely in `RESUME_NOTES.md` under a `## Blockers` section and continue iterating on other phases or alternative approaches. Do NOT emit the completion promise to escape a blocker.

---

## Output format

End each iteration with a brief status line in your text output:

```
📍 Phase {N} — {short status}. Tests: {X passed, Y failed}. Next: {what to do next iteration}.
```

This shows up in the ralph loop log so the user can see progress at a glance.
