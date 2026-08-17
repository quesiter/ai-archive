param(
  [switch]$SkipInitialScan
)

$ErrorActionPreference = "Stop"

function Get-DefaultValue([string]$Name, [string]$Fallback) {
  $value = [Environment]::GetEnvironmentVariable($Name, "Process")
  if ([string]::IsNullOrWhiteSpace($value)) {
    return $Fallback
  }
  return $value
}

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$portableAgent = Join-Path $scriptDir "openclaw-sync.cjs"
$repoAgent = Join-Path (Split-Path -Parent $scriptDir) "apps\openclaw-sync\dist\index.cjs"

if (Test-Path -LiteralPath $portableAgent) {
  $agent = $portableAgent
} elseif (Test-Path -LiteralPath $repoAgent) {
  $agent = $repoAgent
} else {
  throw "Sync agent was not found. Build the agent first or keep openclaw-sync.cjs next to this script."
}

$localAppData = Get-DefaultValue "LOCALAPPDATA" (Join-Path $env:USERPROFILE "AppData\Local")
$logDir = Join-Path $localAppData "AIArchive\Sync\Logs"
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$logPath = Join-Path $logDir ("sync-{0}.log" -f (Get-Date -Format "yyyyMMdd"))

function Write-SyncLog([string]$Message) {
  Add-Content -LiteralPath $logPath -Encoding UTF8 -Value ("[{0}] {1}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss"), $Message)
}

try {
  $configPath = Get-DefaultValue "AI_ARCHIVE_SYNC_CONFIG" (Join-Path $env:USERPROFILE ".config\ai-archive\openclaw-sync.json")
  if (-not (Test-Path -LiteralPath $configPath)) {
    Write-SyncLog "Pairing config is missing: $configPath. Run sync-local-windows.bat once to pair this device before installing the background task."
    exit 2
  }

  $node = (Get-Command node -ErrorAction SilentlyContinue)
  if (-not $node) {
    Write-SyncLog "Node.js was not found in PATH. Install Node.js 22 or newer."
    exit 3
  }

  $env:NODE_OPTIONS = "--max-old-space-size=4096 $($env:NODE_OPTIONS)".Trim()
  $recentDays = Get-DefaultValue "AI_ARCHIVE_SAFE_RECENT_DAYS" "14"
  $maxFiles = Get-DefaultValue "AI_ARCHIVE_SAFE_MAX_FILES" "60"
  $maxFileMb = Get-DefaultValue "AI_ARCHIVE_SAFE_MAX_FILE_MB" "50"
  $maxMessages = Get-DefaultValue "AI_ARCHIVE_SAFE_MAX_MESSAGES" "12000"
  $delayMs = Get-DefaultValue "AI_ARCHIVE_SYNC_DELAY_MS" "750"

  $arguments = @(
    $agent,
    "run",
    "--recent-days", $recentDays,
    "--max-files", $maxFiles,
    "--max-file-mb", $maxFileMb,
    "--max-messages", $maxMessages,
    "--delay-ms", $delayMs
  )
  if ($SkipInitialScan -or (Get-DefaultValue "AI_ARCHIVE_BACKGROUND_SKIP_INITIAL_SCAN" "") -match "^(1|true|yes)$") {
    $arguments += "--skip-initial-scan"
  }

  Write-SyncLog "Starting background sync: node $($arguments -join ' ')"
  $previousErrorActionPreference = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  try {
    & $node.Source @arguments *>> $logPath
    $exitCode = if ($LASTEXITCODE -is [int]) { $LASTEXITCODE } else { 0 }
  } finally {
    $ErrorActionPreference = $previousErrorActionPreference
  }
  Write-SyncLog "Background sync exited with code $exitCode"
  exit $exitCode
} catch {
  Write-SyncLog "Background sync failed: $($_.Exception.Message)"
  exit 1
}
