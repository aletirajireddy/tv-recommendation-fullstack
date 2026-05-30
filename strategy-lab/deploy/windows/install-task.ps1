<#
.SYNOPSIS
  Registers a Windows Scheduled Task that runs the strategy-lab archiver
  automatically, so you never have to remember to back up Stream D data.

.DESCRIPTION
  Creates task "StrategyLabArchiver" that:
    • runs at logon AND at startup (captures the previous session's data the
      moment the machine wakes, before the live app prunes it),
    • repeats every 2 minutes while the machine is on,
    • runs `node src/archive/runArchiver.js --once` (needs ARCHIVE_ENABLED=true in .env),
    • starts when available if a run was missed, and never piles up instances.

  RUN FROM the strategy-lab folder in an ADMIN PowerShell:
    powershell -ExecutionPolicy Bypass -File deploy\windows\install-task.ps1

  Remove with: deploy\windows\uninstall-task.ps1
#>

$ErrorActionPreference = 'Stop'

# Resolve strategy-lab root = two levels up from this script.
$Root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$Node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $Node) { throw "node not found in PATH. Install Node.js first." }

$Script   = Join-Path $Root 'src\archive\runArchiver.js'
$TaskName = 'StrategyLabArchiver'

Write-Host "strategy-lab root : $Root"
Write-Host "node              : $Node"
Write-Host "script            : $Script"

if (-not (Test-Path (Join-Path $Root '.env'))) {
    Write-Warning "No .env found in $Root. Copy .env.example to .env and set ARCHIVE_ENABLED=true, or the archiver will no-op."
}

$action = New-ScheduledTaskAction -Execute $Node -Argument "`"$Script`" --once" -WorkingDirectory $Root

# Two triggers: at logon and at startup. Both get a 2-minute repetition forever.
$tLogon   = New-ScheduledTaskTrigger -AtLogOn
$tStartup = New-ScheduledTaskTrigger -AtStartup
$repeat = (New-ScheduledTaskTrigger -Once -At (Get-Date) `
            -RepetitionInterval (New-TimeSpan -Minutes 2) `
            -RepetitionDuration ([TimeSpan]::MaxValue)).Repetition
$tLogon.Repetition   = $repeat
$tStartup.Repetition = $repeat

$settings = New-ScheduledTaskSettingsSet `
    -StartWhenAvailable `
    -MultipleInstances IgnoreNew `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 10) `
    -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) `
    -DontStopOnIdleEnd

if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    Write-Host "Removed existing task (re-registering)."
}

Register-ScheduledTask -TaskName $TaskName `
    -Action $action -Trigger @($tLogon, $tStartup) -Settings $settings `
    -Description "Archives strategy-lab Stream D / watchlist data before the live DB prunes it (every 2 min)." `
    -RunLevel Limited | Out-Null

Write-Host "`n✅ Registered scheduled task '$TaskName'."
Write-Host "   Starting one run now to verify..."
Start-ScheduledTask -TaskName $TaskName
Start-Sleep -Seconds 3
Get-ScheduledTask -TaskName $TaskName | Get-ScheduledTaskInfo |
    Select-Object LastRunTime, LastTaskResult, NextRunTime | Format-List
Write-Host "Check it worked:  cd `"$Root`"; npm run health"
