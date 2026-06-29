<#
.SYNOPSIS
    Register the WhatsApp daemon as a Windows scheduled task.
    No admin required — uses Interactive logon principal.

.PARAMETER TaskName
    Task Scheduler entry name. Defaults to "WhatsApp Daemon".
#>
[CmdletBinding()]
param(
    [string]$TaskName = "WhatsApp Daemon"
)

$ErrorActionPreference = "Stop"

$batPath = Join-Path $PSScriptRoot "start-daemon.bat"
if (-not (Test-Path $batPath)) {
    throw "start-daemon.bat not found at $batPath"
}

$action   = New-ScheduledTaskAction -Execute $batPath
$trigger  = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$principal = New-ScheduledTaskPrincipal `
    -UserId     $env:USERNAME `
    -LogonType  Interactive `
    -RunLevel   Limited
$settings = New-ScheduledTaskSettingsSet `
    -RestartCount              3 `
    -RestartInterval           (New-TimeSpan -Minutes 1) `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable

if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
    Write-Host "Removing existing task '$TaskName'"
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
}

Register-ScheduledTask `
    -TaskName   $TaskName `
    -Action     $action `
    -Trigger    $trigger `
    -Principal  $principal `
    -Settings   $settings `
    -Description "Claude WhatsApp Integration daemon" | Out-Null

Write-Host "Registered '$TaskName'." -ForegroundColor Green
Write-Host "Verify with: Get-ScheduledTask -TaskName '$TaskName'"
