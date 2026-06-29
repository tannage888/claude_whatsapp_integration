# Status — Claude WhatsApp Integration

**As of:** 2026-05-14
**Stage:** `production_deploy`

## What's done

All 15 implementation phases complete, plus:
- Auth, message capture, SQLite state DB, read endpoints, no-read list
- Send, membership, gap detection + backfill, phone-export importer
- CLI, production hardening, end-to-end smoke test
- Contact context scraper (Phase 13), ZIP export ingestion (Phase 14)
- `GET /api/groups` endpoint (groupFetchAllParticipating, participants in E164)

160 tests passing, zero TypeScript errors.

Manual acceptance complete (2026-05-11): all critical API endpoints verified
against live WhatsApp account (+447879648011). See `MANUAL_VERIFICATION.md`.

Known issues (non-blocking):
- `DELETE /api/auth` returns EPERM on Windows while daemon is running
- Group participants empty in multi-device mode (@lid JIDs filtered by design)

## Production deployment — Task Scheduler setup

`scripts\start-daemon.bat` created (2026-05-11). Registers the daemon to run
at logon and redirects output to `logs\daemon.log`.

Task Scheduler registration blocked by OS permissions (access denied even for
current user). Human must complete registration with admin rights:

```powershell
# Run in an elevated (Run as Administrator) PowerShell:
$batPath = "C:\dev\claude_whatsapp_integration\scripts\start-daemon.bat"
$action = New-ScheduledTaskAction -Execute $batPath
$trigger = New-ScheduledTaskTrigger -AtLogOn
$settings = New-ScheduledTaskSettingsSet -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
Register-ScheduledTask -TaskName "WhatsApp Daemon" -Action $action -Trigger $trigger -Settings $settings -Description "Claude WhatsApp Integration daemon"
# Verify:
Start-ScheduledTask -TaskName "WhatsApp Daemon"
Invoke-RestMethod http://localhost:3100/api/status
```

After registering, reboot and confirm `GET http://localhost:3100/api/status`
responds before marking complete.

## Production deployment — NSSM attempt (2026-05-14)

NSSM installed via Scoop (`scoop install nssm` → `C:\Users\seang\scoop\shims\nssm.exe`).

`nssm install "WhatsAppDaemon" ...` failed with:

```
Administrator access is needed to install a service.
```

Both Task Scheduler registration (previous attempt) and NSSM service installation
require an elevated shell. This is a Windows security boundary that cannot be
crossed from a non-elevated process.

## Re-dispatch note (2026-05-14)

Multiple Orchestra dispatches (2nd and 3rd) confirmed the same result: both
Task Scheduler registration and `nssm install` fail with the same message:

```
Administrator access is needed to install a service.
```

No code change can bypass this. Human action required. Status set to `paused`
to stop further automatic re-dispatching.

## What's next — human action required

Run **one** of the following in an **elevated (Run as Administrator)** terminal:

### Option A — NSSM service (recommended, survives reboot without login)

```powershell
# 1. Install NSSM if not already present
scoop install nssm   # or: winget install nssm

# 2. Register the service
nssm install WhatsAppDaemon "C:\dev\claude_whatsapp_integration\scripts\start-daemon.bat"
nssm set WhatsAppDaemon AppDirectory "C:\dev\claude_whatsapp_integration"
nssm set WhatsAppDaemon AppStdout "C:\dev\claude_whatsapp_integration\logs\daemon.log"
nssm set WhatsAppDaemon AppStderr "C:\dev\claude_whatsapp_integration\logs\daemon.log"
nssm set WhatsAppDaemon Start SERVICE_AUTO_START

# 3. Start it
nssm start WhatsAppDaemon

# 4. Verify
Invoke-RestMethod http://localhost:3100/api/status
```

### Option B — Task Scheduler (runs only when logged in)

```powershell
# Run in elevated PowerShell:
$batPath = "C:\dev\claude_whatsapp_integration\scripts\start-daemon.bat"
$action = New-ScheduledTaskAction -Execute $batPath
$trigger = New-ScheduledTaskTrigger -AtLogOn
$settings = New-ScheduledTaskSettingsSet -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
Register-ScheduledTask -TaskName "WhatsApp Daemon" -Action $action -Trigger $trigger -Settings $settings -Description "Claude WhatsApp Integration daemon"
Start-ScheduledTask -TaskName "WhatsApp Daemon"
Invoke-RestMethod http://localhost:3100/api/status
```

After registering with either option, reboot and confirm `GET http://localhost:3100/api/status`
responds. Project is then fully complete.
