param(
  [Parameter(Mandatory = $true)][string]$ServerUrl,
  [Parameter(Mandatory = $true)][string]$ConfigPath,
  [string]$TaskName = "AI Archive Local Sync"
)

$ErrorActionPreference = "Stop"
$server = [Uri]$ServerUrl
if (-not $server.IsAbsoluteUri -or
    ($server.Scheme -ne "https" -and -not ($server.Scheme -eq "http" -and $server.IsLoopback)) -or
    $server.UserInfo) {
  throw "The archive server must use HTTPS outside localhost."
}
$origin = $server.GetLeftPart([UriPartial]::Authority)
$ConfigPath = (Resolve-Path -LiteralPath $ConfigPath).Path
$config = [IO.File]::ReadAllText($ConfigPath, [Text.Encoding]::UTF8) | ConvertFrom-Json
if (-not $config.serverUrl -or -not $config.deviceId -or -not $config.deviceToken) {
  throw "Existing pairing configuration is incomplete. No configuration has been changed."
}
Write-Host "归档服务：$origin"
$code = Read-Host "请输入新建的 Windows / OpenClaw/Codex 同步代理配对码（不要使用 Chrome 扩展配对码）"
if ([string]::IsNullOrWhiteSpace($code)) { throw "Pairing code is required." }

$task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($task -and $task.State -eq "Running") {
  Stop-ScheduledTask -TaskName $TaskName
}
$backup = $ConfigPath + ".before-pair-" + (Get-Date -Format "yyyyMMdd-HHmmss-fff") + ".bak"
$acl = Get-Acl -LiteralPath $ConfigPath
Copy-Item -LiteralPath $ConfigPath -Destination $backup
Set-Acl -LiteralPath $backup -AclObject $acl
$temporary = $ConfigPath + "." + [Guid]::NewGuid().ToString("N") + ".tmp"
try {
  $body = @{ code = $code.Trim(); kind = "openclaw_sync" } | ConvertTo-Json -Compress
  $claimed = Invoke-RestMethod -Uri "$origin/api/v1/devices/claim" -Method Post -ContentType "application/json" -Body $body -TimeoutSec 30
  $deviceId = [Guid]::Empty
  if (-not [Guid]::TryParse([string]$claimed.deviceId, [ref]$deviceId) -or
      [string]::IsNullOrWhiteSpace($claimed.token) -or $claimed.token.Length -lt 20) {
    throw "Server returned an invalid pairing response. Existing configuration has been preserved."
  }
  $config.serverUrl = $origin
  $config.deviceId = $claimed.deviceId
  $config.deviceToken = $claimed.token
  [IO.File]::WriteAllText($temporary, ($config | ConvertTo-Json -Depth 100), (New-Object Text.UTF8Encoding($false)))
  Set-Acl -LiteralPath $temporary -AclObject $acl
  Move-Item -LiteralPath $temporary -Destination $ConfigPath -Force
} finally {
  if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary }
}
Write-Host "重新配对成功，采集目录和同步进度已保留。"
if ($task) {
  Start-ScheduledTask -TaskName $TaskName
  Write-Host "现有后台同步任务已启动。"
} else {
  Write-Host "执行 .\sync-local-windows.bat install 安装后台任务，或使用 run 前台同步。"
}
