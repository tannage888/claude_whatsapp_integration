---
project: claude_whatsapp_integration
display_name: "Claude WhatsApp Integration"
owner: mark
status: done
priority: 1
created: 2026-04-19
last_reviewed: 2026-09-22

permissions: bypassPermissions
max_concurrent_agents: 1
shared_resources:
  - whatsapp_daemon

current_stage: done

stages:
  live_message_hook:
    model: sonnet
    loop: single
    prompt: |
      Implement the WA_INCOMING_HOOK_URL live-push feature. This is a priority-1
      change that unblocks live WhatsApp capture in Kit — without it, Kit's
      MessageRouter is only called by the scheduled sweep; real-time capture never fires.

      Kit's side is already built: POST /api/incoming-message exists at
      gateway/src/routes/api.ts:92 and calls router.handleMessage(parsed.data).
      No Kit changes needed. All work is in this repo.

      Changes required:

      1. src/config.ts
         Add to the Config interface:
           WA_INCOMING_HOOK_URL: string | null;
         Add to the config object:
           WA_INCOMING_HOOK_URL: nullableStrEnv("WA_INCOMING_HOOK_URL"),

      2. src/index.ts
         After the existing wa.on("message:received", ...) group-membership handler,
         add a second listener (inside an `if (config.WA_INCOMING_HOOK_URL)` guard):

           if (config.WA_INCOMING_HOOK_URL) {
             const hookUrl = config.WA_INCOMING_HOOK_URL;
             wa.on("message:received", (msg: any) => {
               fetch(hookUrl, {
                 method: "POST",
                 headers: { "Content-Type": "application/json" },
                 body: JSON.stringify({
                   remoteJid:  msg.remoteJid,
                   fromMe:     msg.fromMe ?? false,
                   body:       msg.body ?? "",
                   timestamp:  msg.timestamp,
                   messageId:  msg.messageId,
                 }),
               }).catch(() => {}); // best-effort; Kit outage must not crash the daemon
             });
           }

         The payload schema matches Kit's incomingMsgSchema exactly
         (remoteJid, fromMe, body, timestamp epoch ms, messageId).

      3. .env.example
         Add (commented out):
           # WA_INCOMING_HOOK_URL=http://127.0.0.1:3141/api/incoming-message

      4. Add a unit test covering:
         - hook fires with correct payload when WA_INCOMING_HOOK_URL is set
         - hook is skipped (no fetch call) when WA_INCOMING_HOOK_URL is null
         - fetch errors are swallowed (daemon does not throw)

      Run npm test. All existing and new tests must pass.
      Advance current_stage to production_deploy when done.
    success_criteria: |
      npm test exits 0.
      src/config.ts exports WA_INCOMING_HOOK_URL as string | null.
      src/index.ts fires a best-effort POST to WA_INCOMING_HOOK_URL on message:received.
      .env.example documents the variable.
    needs_human_for:
      - kit_gateway_schema_changes

  groups_endpoint:
    model: sonnet
    loop: single
    prompt: |
      Add a GET /api/groups endpoint to the WhatsApp daemon.
      Call Baileys' sock.groupFetchAllParticipating() and return an array of:
        [{ jid: string, name: string, participants: string[] }]
      where participants are phone numbers in international format (e.g. "+447700900123").
      Add the route in src/ following the existing routing pattern. Add a test.
      Run npm test. Open a PR when tests pass.
      Advance current_stage to manual_acceptance when done.
    success_criteria: |
      npm test exits 0.
      A GET /api/groups route exists in the daemon source.
    needs_human_for:
      - baileys_api_breaking_changes

  manual_acceptance:
    model: sonnet
    loop: single
    prompt: |
      PREREQUISITE: A live WhatsApp account must be paired (QR code scanned)
      before this stage can run. If not done, emit BLOCKED: live WhatsApp
      account not paired — scan QR code first.

      Run through the manual acceptance checklist in MANUAL_VERIFICATION.md.
      For each unchecked item, document the result. If all items pass, set
      status: active and advance current_stage to production_deploy.
      If any item fails, document the failure and leave status: paused.
    success_criteria: |
      All items in MANUAL_VERIFICATION.md are checked and status is updated.
    needs_human_for:
      - live WhatsApp account pairing (QR code scan)

  production_deploy:
    model: sonnet
    loop: single
    prompt: |
      The manual acceptance checklist and live_message_hook are complete.
      Install the daemon as a Windows service via NSSM (instructions in README).

      NOTE: A previous attempt failed with "Access is denied" when registering
      via Task Scheduler as the current user. If NSSM also fails with a
      permissions error, emit DECISION_NEEDED with the exact error and the
      recommended fix (e.g. run elevated, use a different service account).
      Do not loop on a permissions wall — surface it immediately.

      Confirm the service starts cleanly and survives a reboot. Update STATUS.md
      with the outcome. Advance current_stage to done and set status: done when complete.
    success_criteria: |
      Daemon runs as a Windows service and survives reboot.

next_actions: []
blockers: []
human_tasks: []
last_dispatch:
  task_id: "claude_whatsapp_integration-74984c68"
  stage: "production_deploy"
  model: "sonnet"
  loop: "single"
  started: "2026-05-14T08:54:21"
  ended: "2026-05-14T08:57:55"
  result: "done"
  iterations_used: 1
  tokens: { input: 0, output: 0, cost_usd: 0 }
  note: "Daemon already running under pm2 (kit-daemon, id 1) on port 3142. Task Scheduler entry created then removed — pm2 is the process manager. Marked done 2026-05-16."
history: []
---

# Claude WhatsApp Integration

All 15 implementation phases complete (138 tests, 0 failures). Waiting on manual
acceptance testing against a live WhatsApp account before production deploy.

Full spec: [docs/claude_whatsapp_integration.md](claude_whatsapp_integration.md)
Implementation notes: [RESUME_NOTES.md](../RESUME_NOTES.md)
