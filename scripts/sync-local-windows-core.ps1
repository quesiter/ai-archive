param(
  [Parameter(Mandatory = $true)][string]$AgentPath,
  [string]$ProjectRoot = "",
  [switch]$BuildFromSource,
  [string]$Command = ""
)

$ErrorActionPreference = "Stop"
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path

function Get-EnvDefault([string]$Name, [string]$Fallback) {
  $value = [Environment]::GetEnvironmentVariable($Name, "Process")
  if ([string]::IsNullOrWhiteSpace($value)) { return $Fallback }
  return $value
}

function Invoke-Checked([string]$Program, [string[]]$Arguments) {
  & $Program @Arguments
  if ($LASTEXITCODE -ne 0) { throw "$Program exited with code $LASTEXITCODE" }
}

function Show-Usage {
  Write-Host @"
知言归藏 Windows 本地同步

  sync-local-windows.bat              安装或重启后台同步
  sync-local-windows.bat rebuild-only 安全范围单次同步
  sync-local-windows.bat watch-only   只监视后续变化
  sync-local-windows.bat full-rebuild 明确执行全部历史重建
  sync-local-windows.bat install      安装后台任务
  sync-local-windows.bat uninstall    卸载后台任务
"@
}

if ($Command -in @("help", "--help", "-h", "/?")) { Show-Usage; exit 0 }

if ($Command -in @("uninstall", "uninstall-background")) {
  & (Join-Path $scriptDir "uninstall-windows-sync-task.ps1")
  exit $LASTEXITCODE
}

$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) { throw "Node.js 22 or newer was not found in PATH." }
$nodeMajor = [int](& $node.Source -p "process.versions.node.split('.')[0]")
if ($nodeMajor -lt 22) { throw "Node.js 22 or newer is required." }

if ($BuildFromSource) {
  if ([string]::IsNullOrWhiteSpace($ProjectRoot)) { throw "ProjectRoot is required for a source build." }
  Push-Location $ProjectRoot
  try {
    $pnpm = Get-Command pnpm -ErrorAction SilentlyContinue
    if (-not $pnpm) { throw "pnpm is required for a source build." }
    Invoke-Checked $pnpm.Source @("install")
    Invoke-Checked $pnpm.Source @("--filter", "@ai-archive/contracts", "build")
    Invoke-Checked $pnpm.Source @("--filter", "@ai-archive/openclaw-sync", "build")
  } finally { Pop-Location }
}

if (-not (Test-Path -LiteralPath $AgentPath)) { throw "Sync agent was not found: $AgentPath" }
$AgentPath = (Resolve-Path -LiteralPath $AgentPath).Path
$serverUrl = Get-EnvDefault "AI_ARCHIVE_SERVER" "https://ai-archive.gyee.tech:18443"
$configPath = Get-EnvDefault "AI_ARCHIVE_SYNC_CONFIG" (Join-Path $env:USERPROFILE ".config\ai-archive\openclaw-sync.json")
$openClawRoot = Get-EnvDefault "AI_ARCHIVE_OPENCLAW_ROOT" (Join-Path $env:USERPROFILE ".openclaw")
$codexRoot = Get-EnvDefault "AI_ARCHIVE_CODEX_ROOT" (Join-Path $env:USERPROFILE ".codex")
$claudeRoot = Get-EnvDefault "AI_ARCHIVE_CLAUDE_CODE_ROOT" (Join-Path $env:USERPROFILE ".claude")
$recentDays = Get-EnvDefault "AI_ARCHIVE_SAFE_RECENT_DAYS" "14"
$maxFiles = Get-EnvDefault "AI_ARCHIVE_SAFE_MAX_FILES" "60"
$maxFileMb = Get-EnvDefault "AI_ARCHIVE_SAFE_MAX_FILE_MB" "50"
$maxMessages = Get-EnvDefault "AI_ARCHIVE_SAFE_MAX_MESSAGES" "12000"
$delayMs = Get-EnvDefault "AI_ARCHIVE_SYNC_DELAY_MS" "750"
$env:NODE_OPTIONS = "--max-old-space-size=4096 $($env:NODE_OPTIONS)".Trim()

if (-not (Test-Path -LiteralPath $configPath)) {
  $pairCode = Read-Host "请在 Web 设备页生成配对码并输入"
  if ([string]::IsNullOrWhiteSpace($pairCode)) { throw "Pairing code is required." }
  $pairArgs = @($AgentPath, "pair", "--server", $serverUrl, "--code", $pairCode, "--openclaw-root", $openClawRoot, "--codex-root", $codexRoot)
  if (Test-Path -LiteralPath $claudeRoot) { $pairArgs += @("--claude-code-root", $claudeRoot) }
  Invoke-Checked $node.Source $pairArgs
}

$safeArgs = @("--recent-days", $recentDays, "--max-files", $maxFiles, "--max-file-mb", $maxFileMb, "--max-messages", $maxMessages, "--delay-ms", $delayMs)
switch ($Command.ToLowerInvariant()) {
  "rebuild-only" { Invoke-Checked $node.Source (@($AgentPath, "rebuild") + $safeArgs); exit 0 }
  "once" { Invoke-Checked $node.Source (@($AgentPath, "rebuild") + $safeArgs); exit 0 }
  "watch-only" { Invoke-Checked $node.Source (@($AgentPath, "run") + $safeArgs + @("--skip-initial-scan")); exit 0 }
  "full-rebuild" { Invoke-Checked $node.Source @($AgentPath, "full-rebuild", "--delay-ms", $delayMs); exit 0 }
  "rebuild-all" { Invoke-Checked $node.Source @($AgentPath, "full-rebuild", "--delay-ms", $delayMs); exit 0 }
}

& (Join-Path $scriptDir "install-windows-sync-task.ps1")
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
Write-Host "后台同步已安装并启动。"
