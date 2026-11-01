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
知言归藏 Windows 本地同步（启动器 V2.4.12）

  sync-local-windows.bat              安装或重启后台同步
  sync-local-windows.bat run          前台同步近期记录并持续监听，终端需保持打开
  sync-local-windows.bat pair         重新配对，保留采集目录和同步进度
  sync-local-windows.bat rebuild-only 安全范围单次同步
  sync-local-windows.bat watch-only   只监视后续变化
  sync-local-windows.bat full-rebuild 明确执行全部历史重建
  sync-local-windows.bat install      安装后台任务
  sync-local-windows.bat uninstall    卸载后台任务
"@
}

$commandName = $Command.Trim().ToLowerInvariant()
if ($commandName -in @("help", "--help", "-h", "/?")) { Show-Usage; exit 0 }
if ($commandName -notin @("", "install", "background", "install-background", "uninstall", "uninstall-background", "run", "foreground", "pair", "re-pair", "rebuild-only", "once", "watch-only", "full-rebuild", "rebuild-all")) {
  Write-Host "未知命令：$Command"
  Show-Usage
  exit 2
}

if ($commandName -in @("uninstall", "uninstall-background")) {
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
$serverUrl = Get-EnvDefault "AI_ARCHIVE_SERVER" "https://ai-archive.cuizhaoyang.cn"
$configPath = Get-EnvDefault "AI_ARCHIVE_SYNC_CONFIG" (Join-Path $env:USERPROFILE ".config\ai-archive\openclaw-sync.json")
$openClawRoot = Get-EnvDefault "AI_ARCHIVE_OPENCLAW_ROOT" (Join-Path $env:USERPROFILE ".openclaw")
$codexRoot = Get-EnvDefault "AI_ARCHIVE_CODEX_ROOT" (Join-Path $env:USERPROFILE ".codex")
$claudeRoot = Get-EnvDefault "AI_ARCHIVE_CLAUDE_CODE_ROOT" (Join-Path $env:USERPROFILE ".claude")
$grokBuildRoot = Get-EnvDefault "AI_ARCHIVE_GROK_BUILD_ROOT" (Get-EnvDefault "GROK_HOME" (Join-Path $env:USERPROFILE ".grok"))
if (Test-Path -LiteralPath $grokBuildRoot -PathType Container) { $env:AI_ARCHIVE_GROK_BUILD_ROOT = $grokBuildRoot }
$recentDays = Get-EnvDefault "AI_ARCHIVE_SAFE_RECENT_DAYS" "14"
$maxFiles = Get-EnvDefault "AI_ARCHIVE_SAFE_MAX_FILES" "60"
$maxFileMb = Get-EnvDefault "AI_ARCHIVE_SAFE_MAX_FILE_MB" "50"
$maxMessages = Get-EnvDefault "AI_ARCHIVE_SAFE_MAX_MESSAGES" "12000"
$delayMs = Get-EnvDefault "AI_ARCHIVE_SYNC_DELAY_MS" "750"
$env:NODE_OPTIONS = "--max-old-space-size=4096 $($env:NODE_OPTIONS)".Trim()

if ($commandName -in @("pair", "re-pair") -and (Test-Path -LiteralPath $configPath)) {
  & (Join-Path $scriptDir "repair-windows-sync-pairing.ps1") -ServerUrl $serverUrl -ConfigPath $configPath
  exit $LASTEXITCODE
}

if (-not (Test-Path -LiteralPath $configPath)) {
  $pairCode = Read-Host "请在 Web 设备页生成配对码并输入"
  if ([string]::IsNullOrWhiteSpace($pairCode)) { throw "Pairing code is required." }
  $pairArgs = @($AgentPath, "pair", "--server", $serverUrl, "--code", $pairCode, "--openclaw-root", $openClawRoot, "--codex-root", $codexRoot)
  if (Test-Path -LiteralPath $claudeRoot) { $pairArgs += @("--claude-code-root", $claudeRoot) }
  if (Test-Path -LiteralPath $grokBuildRoot -PathType Container) { $pairArgs += @("--grok-build-root", $grokBuildRoot) }
  Invoke-Checked $node.Source $pairArgs
}

$safeArgs = @("--recent-days", $recentDays, "--max-files", $maxFiles, "--max-file-mb", $maxFileMb, "--max-messages", $maxMessages, "--delay-ms", $delayMs)
switch ($commandName) {
  { $_ -in @("pair", "re-pair") } {
    Write-Host "配对已完成。执行 .\sync-local-windows.bat install 安装后台任务，或使用 run 前台同步。"
    exit 0
  }
  { $_ -in @("run", "foreground") } {
    Write-Host "前台同步已启动：先扫描近期记录，再持续监听变化。请保持此窗口打开，按 Ctrl+C 停止。"
    Invoke-Checked $node.Source (@($AgentPath, "run") + $safeArgs)
    exit 0
  }
  "rebuild-only" { Invoke-Checked $node.Source (@($AgentPath, "rebuild") + $safeArgs); exit 0 }
  "once" { Invoke-Checked $node.Source (@($AgentPath, "rebuild") + $safeArgs); exit 0 }
  "watch-only" { Invoke-Checked $node.Source (@($AgentPath, "run") + $safeArgs + @("--skip-initial-scan")); exit 0 }
  "full-rebuild" { Invoke-Checked $node.Source @($AgentPath, "full-rebuild", "--delay-ms", $delayMs); exit 0 }
  "rebuild-all" { Invoke-Checked $node.Source @($AgentPath, "full-rebuild", "--delay-ms", $delayMs); exit 0 }
}

& (Join-Path $scriptDir "install-windows-sync-task.ps1")
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
Write-Host "后台同步已安装并启动。"
