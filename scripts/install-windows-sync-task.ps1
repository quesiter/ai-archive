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
$userId = [Security.Principal.WindowsIdentity]::GetCurrent().Name
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $userId
$settings = New-ScheduledTaskSettingsSet `
  -MultipleInstances IgnoreNew `
  -RestartCount 3 `
  -RestartInterval (New-TimeSpan -Minutes 1) `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -ExecutionTimeLimit (New-TimeSpan -Seconds 0)
$principal = New-ScheduledTaskPrincipal -UserId $userId -LogonType Interactive -RunLevel Limited

try {
  Register-ScheduledTask `
    -TaskName $TaskName `
    -Action $action `
    -Trigger $trigger `
    -Settings $settings `
    -Principal $principal `
    -Description "Zhiyan Guicang local conversation sync after user logon." `
    -Force | Out-Null

  Start-ScheduledTask -TaskName $TaskName
} catch {
  if ($_.Exception -is [UnauthorizedAccessException] -or
      $_.Exception.HResult -eq -2147024891 -or
      $_.FullyQualifiedErrorId -match "80070005" -or
      $_.Exception.Message -match "Access is denied|拒绝访问") {
    Write-Host "后台任务安装或启动被 Windows 拒绝（0x80070005）。" -ForegroundColor Yellow
    Write-Host "请由管理员检查同名任务的权限及公司策略，再安装登录后自动同步。"
    Write-Host "如需手动前台同步，请执行：.\sync-local-windows.bat run"
    Write-Host "前台模式需要保持终端打开，关闭窗口后同步停止。"
  }
  throw
}

$logDir = Join-Path $env:LOCALAPPDATA "AIArchive\Sync\Logs"
Write-Host "Installed and started scheduled task: $TaskName"
Write-Host "Logs: $logDir"
