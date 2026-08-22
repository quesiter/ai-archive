param(
  [string]$TaskName = "AI Archive Local Sync",
  [string]$RunnerPath = ""
)

$ErrorActionPreference = "Stop"

if ([string]::IsNullOrWhiteSpace($RunnerPath)) {
  $RunnerPath = Join-Path (Split-Path -Parent $MyInvocation.MyCommand.Path) "sync-local-windows-background.ps1"
}
$RunnerPath = (Resolve-Path -LiteralPath $RunnerPath).Path

$configPath = if ([string]::IsNullOrWhiteSpace($env:AI_ARCHIVE_SYNC_CONFIG)) {
  Join-Path $env:USERPROFILE ".config\ai-archive\openclaw-sync.json"
} else {
  $env:AI_ARCHIVE_SYNC_CONFIG
}

if (-not (Test-Path -LiteralPath $configPath)) {
  throw "Pairing config is missing: $configPath. Run sync-local-windows.bat once before installing the background task."
}

$escapedRunner = $RunnerPath.Replace('"', '\"')
$action = New-ScheduledTaskAction `
  -Execute "powershell.exe" `
  -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$escapedRunner`""
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet `
  -MultipleInstances IgnoreNew `
  -RestartCount 3 `
  -RestartInterval (New-TimeSpan -Minutes 1) `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -ExecutionTimeLimit (New-TimeSpan -Seconds 0)
$userId = if ([string]::IsNullOrWhiteSpace($env:USERDOMAIN)) {
  $env:USERNAME
} else {
  "$env:USERDOMAIN\$env:USERNAME"
}
$principal = New-ScheduledTaskPrincipal -UserId $userId -LogonType Interactive -RunLevel Limited

Register-ScheduledTask `
  -TaskName $TaskName `
  -Action $action `
  -Trigger $trigger `
  -Settings $settings `
  -Principal $principal `
  -Description "Zhiyan Guicang local conversation sync after user logon." `
  -Force | Out-Null

Start-ScheduledTask -TaskName $TaskName

$logDir = Join-Path $env:LOCALAPPDATA "AIArchive\Sync\Logs"
Write-Host "Installed and started scheduled task: $TaskName"
Write-Host "Logs: $logDir"
