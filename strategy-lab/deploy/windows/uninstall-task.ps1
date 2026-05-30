<#
.SYNOPSIS  Removes the StrategyLabArchiver scheduled task.
.USAGE     powershell -ExecutionPolicy Bypass -File deploy\windows\uninstall-task.ps1
#>
$ErrorActionPreference = 'Stop'
$TaskName = 'StrategyLabArchiver'
if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    Write-Host "✅ Removed scheduled task '$TaskName'."
} else {
    Write-Host "Task '$TaskName' not found — nothing to remove."
}
