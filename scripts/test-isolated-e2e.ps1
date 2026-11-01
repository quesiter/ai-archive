[CmdletBinding()]
param(
  [string]$NodeExe = "",
  [ValidateRange(30, 900)][int]$TimeoutSeconds = 180
)

# Requires installed workspace dependencies, a web build, Docker, and Node 22/24.
# Owns only its unique labeled PostgreSQL container and recorded Node processes.
# All synthetic data and logs remain under .codex-tmp/isolated-e2e-<run-id>.

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$workspace = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$runId = [Guid]::NewGuid().ToString("N")
$containerName = "archive-isolated-e2e-$runId"
$ownerLabel = "com.ai-archive.isolated-e2e.run"
$image = "postgres:17-alpine"
$runRoot = Join-Path $workspace ".codex-tmp\isolated-e2e-$runId"
$null = New-Item -ItemType Directory -Path $runRoot
$ownedProcesses = [Collections.Generic.List[object]]::new()
$results = [Collections.Generic.List[object]]::new()
$cleanupErrors = [Collections.Generic.List[string]]::new()
$containerId = $null
$nodeVersion = $null
$migrationBaseline = $null
$allPassed = $false

function Get-OwnedContainer {
  $raw = & docker inspect $containerName 2>$null
  if ($LASTEXITCODE -ne 0) { return $null }
  $item = @($raw | ConvertFrom-Json)[0]
  if ($item.Id -notmatch '^[a-f0-9]{64}$' -or $item.Name -ne "/$containerName" -or
      $item.Config.Labels.$ownerLabel -ne $runId) {
    throw "Refusing to operate on a container without this run's exact identity and ownership label."
  }
  return $item
}

function Invoke-DockerChecked([string[]]$Arguments) {
  $output = & docker @Arguments 2>&1
  if ($LASTEXITCODE -ne 0) { throw "Docker command failed. Isolated run logs: $runRoot" }
  return $output
}

function Assert-IsolatedTarget([string]$DatabaseUrl, [string]$BaseUrl) {
  $database = [uri]$DatabaseUrl
  $target = [uri]$BaseUrl
  if ($database.Scheme -ne "postgresql" -or $database.Host -ne "127.0.0.1" -or
      $database.AbsolutePath -notmatch '^/archive_e2e_(api|projects|search)_[0-9]+$' -or
      $database.Port -le 0 -or $target.Scheme -ne "http" -or $target.Host -ne "127.0.0.1" -or
      $target.Port -le 0 -or $target.AbsolutePath -ne "/") {
    throw "Refusing a target outside this runner's disposable loopback databases and HTTP origins."
  }
}

function Get-FreeLoopbackPort {
  $listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0)
  try { $listener.Start(); return ([Net.IPEndPoint]$listener.LocalEndpoint).Port }
  finally { $listener.Stop() }
}

function Start-OwnedNode([string]$Role, [string]$Entry, [string]$Directory, [hashtable]$Environment, [switch]$TypeScript) {
  $saved = @{}
  foreach ($key in $Environment.Keys) {
    $saved[$key] = [Environment]::GetEnvironmentVariable($key, "Process")
    [Environment]::SetEnvironmentVariable($key, [string]$Environment[$key], "Process")
  }
  try {
    $arguments = @()
    if ($TypeScript) { $arguments += @("--import", ('"' + $loaderUri + '"')) }
    $arguments += ('"' + $Entry + '"')
    $process = Start-Process -FilePath $NodeExe -ArgumentList $arguments -WorkingDirectory $Directory `
      -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $Directory "$Role.stdout.log") `
      -RedirectStandardError (Join-Path $Directory "$Role.stderr.log")
    # Keep the process handle open so Windows PowerShell 5.1 retains ExitCode
    # even when a short-lived child finishes before Wait-OwnedNode runs.
    $null = $process.Handle
    $owned = [pscustomobject]@{ Process = $process; Started = $process.StartTime.ToUniversalTime().Ticks; Role = $Role }
    $ownedProcesses.Add($owned)
    return $owned
  } finally {
    foreach ($key in $saved.Keys) { [Environment]::SetEnvironmentVariable($key, $saved[$key], "Process") }
  }
}

function Stop-OwnedNode($Owned) {
  $Owned.Process.Refresh()
  if ($Owned.Process.HasExited) { return }
  $current = Get-Process -Id $Owned.Process.Id -ErrorAction SilentlyContinue
  if ($null -eq $current) { return }
  if ($current.StartTime.ToUniversalTime().Ticks -ne $Owned.Started -or
      [IO.Path]::GetFullPath($current.Path) -ne $NodeExe) {
    throw "Refusing to stop a process whose start time or executable does not match this run."
  }
  Stop-Process -Id $current.Id -Force
  $null = $Owned.Process.WaitForExit(10000)
}

function Wait-OwnedNode($Owned) {
  if (-not $Owned.Process.WaitForExit($TimeoutSeconds * 1000)) {
    Stop-OwnedNode $Owned
    throw "The isolated $($Owned.Role) process exceeded its timeout; see retained logs."
  }
  $Owned.Process.Refresh()
  if ($null -eq $Owned.Process.ExitCode) { throw "Child process exit code is unavailable; refusing to mark the run passed." }
  return $Owned.Process.ExitCode
}

try {
  if (-not $NodeExe) { $NodeExe = (Get-Command node -ErrorAction Stop).Source }
  $NodeExe = (Resolve-Path -LiteralPath $NodeExe).Path
  $nodeVersion = (& $NodeExe --version).Trim()
  if ($LASTEXITCODE -ne 0 -or $nodeVersion -notmatch '^v(22|24)\.') {
    throw "Use Node.js 22 or 24 LTS; pass -NodeExe with its absolute executable path."
  }
  $null = Get-Command docker -ErrorAction Stop
  $null = Invoke-DockerChecked @("image", "inspect", $image)
  $webDist = (Resolve-Path -LiteralPath (Join-Path $workspace "apps\web\dist")).Path
  if (-not (Test-Path -LiteralPath (Join-Path $webDist "index.html"))) { throw "Build the web app before running E2E." }
  $loader = (Resolve-Path -LiteralPath (Join-Path $workspace "apps\server\node_modules\tsx\dist\loader.mjs")).Path
  $loaderUri = ([uri]$loader).AbsoluteUri
  $migrator = (Resolve-Path -LiteralPath (Join-Path $workspace "apps\server\node_modules\drizzle-orm\postgres-js\migrator.js")).Path
  $packageVersion = (Get-Content -Raw -LiteralPath (Join-Path $workspace "package.json") | ConvertFrom-Json).version
  $journal = Get-Content -Raw -LiteralPath (Join-Path $workspace "apps\server\migrations\meta\_journal.json") | ConvertFrom-Json
  $migrationCount = @($journal.entries).Count
  if ($migrationCount -eq 0) { throw "The migration journal must not be empty." }
  for ($index = 0; $index -lt $migrationCount; $index++) {
    $entry = $journal.entries[$index]
    if ($entry.idx -ne $index -or $entry.tag -notmatch ('^{0:D4}_[a-z0-9_]+$' -f $index) -or
        -not (Test-Path -LiteralPath (Join-Path $workspace "apps\server\migrations\$($entry.tag).sql"))) {
      throw "The migration journal must contain contiguous numbered entries with existing SQL files."
    }
  }
  $migrationStart = $journal.entries[0].tag
  $migrationEnd = $journal.entries[-1].tag
  $migrationBaseline = [ordered]@{ count = $migrationCount; first = $migrationStart; last = $migrationEnd }
  if (Test-Path -LiteralPath (Join-Path $workspace ".codex-tmp\.env")) {
    throw "Remove the unexpected .codex-tmp/.env before running isolated tests."
  }
  $migrationsJson = ConvertTo-Json -Compress ([IO.Path]::GetFullPath((Join-Path $workspace "apps\server\migrations")))
  $dbJson = ConvertTo-Json -Compress (([uri](Join-Path $workspace "apps\server\src\db.ts")).AbsoluteUri)
  $migratorJson = ConvertTo-Json -Compress (([uri]$migrator).AbsoluteUri)
  $appJson = ConvertTo-Json -Compress (([uri](Join-Path $workspace "apps\server\src\app.ts")).AbsoluteUri)
  $queueJson = ConvertTo-Json -Compress (([uri](Join-Path $workspace "apps\server\src\services\queue.ts")).AbsoluteUri)
  $guard = @'
import assert from "node:assert/strict";
const database = new URL(process.env.DATABASE_URL);
const origin = new URL(process.env.APP_ORIGIN);
assert.equal(database.hostname, "127.0.0.1");
assert.match(database.pathname, /^\/archive_e2e_(api|projects|search)_\d+$/);
assert.equal(origin.hostname, "127.0.0.1");
assert.equal(origin.protocol, "http:");
'@
  $migrationEntry = Join-Path $runRoot "migrate.mjs"
  @"
$guard
import { migrate } from $migratorJson;
import { db, sqlClient, closeDatabase } from $dbJson;
try {
  await migrate(db, { migrationsFolder: $migrationsJson });
  const [row] = await sqlClient.unsafe('select count(*)::int as count from drizzle.__drizzle_migrations');
  assert.equal(row.count, $migrationCount);
  console.log('PASS all $migrationCount migrations ($migrationStart through $migrationEnd)');
} finally { await closeDatabase(); }
"@ | Set-Content -LiteralPath $migrationEntry -Encoding utf8
  $appEntry = Join-Path $runRoot "app.mjs"
  @"
$guard
import { buildApp } from $appJson;
import { closeDatabase } from $dbJson;
import { stopBoss } from $queueJson;
const app = await buildApp();
// Synthetic databases only: retain the original error behind sanitized API errors.
app.addHook("onError", async (_request, _reply, error) => { console.error(error); });
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => {
  await app.close(); await stopBoss(); await closeDatabase(); process.exit(0);
});
await app.listen({ host: '127.0.0.1', port: Number(process.env.PORT) });
console.log('Isolated loopback app ready');
"@ | Set-Content -LiteralPath $appEntry -Encoding utf8

  Write-Host "Isolated E2E: $nodeVersion; logs $runRoot"
  $created = Invoke-DockerChecked @("run", "--detach", "--rm", "--pull=never", "--name", $containerName,
    "--label", "$ownerLabel=$runId", "--publish", "127.0.0.1::5432", "--env", "POSTGRES_USER=archive_e2e",
    "--env", "POSTGRES_DB=postgres", "--env", "POSTGRES_HOST_AUTH_METHOD=trust", $image)
  $containerId = ($created | Select-Object -Last 1).ToString().Trim()
  $container = Get-OwnedContainer
  if ($null -eq $container -or $container.Id -ne $containerId) { throw "Container ownership verification failed." }
  $binding = @($container.NetworkSettings.Ports.'5432/tcp')[0]
  if ($binding.HostIp -ne "127.0.0.1") { throw "PostgreSQL port must bind only loopback." }
  $postgresPort = [int]$binding.HostPort
  $ready = $false
  for ($attempt = 0; $attempt -lt 60; $attempt++) {
    $null = & docker exec $containerId pg_isready -U archive_e2e -d postgres 2>&1
    if ($LASTEXITCODE -eq 0) { $ready = $true; break }
    Start-Sleep -Milliseconds 500
  }
  if (-not $ready) { throw "Disposable PostgreSQL did not become ready." }

  foreach ($suite in @("api", "projects", "search")) {
    $caseRoot = Join-Path $runRoot $suite
    $null = New-Item -ItemType Directory -Path $caseRoot
    $caseProcesses = [Collections.Generic.List[object]]::new()
    $caseResult = [ordered]@{ suite = $suite; status = "failed"; migrations = 0; exitCode = $null; logs = $caseRoot }
    try {
      $stamp = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
      $databaseName = "archive_e2e_${suite}_$stamp"
      $databaseUrl = "postgresql://archive_e2e@127.0.0.1:${postgresPort}/$databaseName"
      $port = Get-FreeLoopbackPort
      $base = "http://127.0.0.1:$port"
      Assert-IsolatedTarget $databaseUrl $base
      $null = Invoke-DockerChecked @("exec", $containerId, "createdb", "-U", "archive_e2e", "-O", "archive_e2e", $databaseName)
      $keyBytes = New-Object byte[] 32
      $random = [Security.Cryptography.RandomNumberGenerator]::Create()
      try { $random.GetBytes($keyBytes) } finally { $random.Dispose() }
      $environment = @{
        NODE_ENV = "test"; DATABASE_URL = $databaseUrl; APP_ORIGIN = $base; PORT = "$port"
        TSX_TSCONFIG_PATH = (Join-Path $workspace "apps\server\tsconfig.json")
        APP_MASTER_KEY = [Convert]::ToBase64String($keyBytes); COOKIE_SECURE = "false"; TRUST_PROXY = "false"
        WEB_DIST = $webDist; COMPONENT_RELEASE_DIR = (Join-Path $caseRoot "components"); HOST_MONITOR_URL = ""
        IMPORT_INBOX = (Join-Path $caseRoot "imports\inbox"); IMPORT_PROCESSED = (Join-Path $caseRoot "imports\processed")
        IMPORT_FAILED = (Join-Path $caseRoot "imports\failed"); RESTORE_STAGING = (Join-Path $caseRoot "restores")
        ALLOW_PRIVATE_NETWORK_TARGETS = "false"; EXTENSION_ORIGINS = "chrome-extension://daolmhnfgimkgnnadojnmhkkjdolplfi"
        ARCHIVE_STORAGE_BUDGET_GB = ""; LOG_LEVEL = "warn"; TZ = "Asia/Shanghai"
        IMPORT_PROCESSED_RETENTION_DAYS = "30"; IMPORT_FAILED_RETENTION_DAYS = "30"; RESTORE_FAILED_RETENTION_DAYS = "30"
        E2E_BASE_URL = $base; E2E_EXPECTED_VERSION = "V$packageVersion"; E2E_ALLOW_REMOTE = "false"
      }
      foreach ($pathKey in @("COMPONENT_RELEASE_DIR", "IMPORT_INBOX", "IMPORT_PROCESSED", "IMPORT_FAILED", "RESTORE_STAGING")) {
        $null = New-Item -ItemType Directory -Path $environment[$pathKey] -Force
      }
      $migration = Start-OwnedNode "migrate" $migrationEntry $caseRoot $environment -TypeScript
      if ((Wait-OwnedNode $migration) -ne 0) { throw "Fresh database migration failed; see migration logs." }
      $caseResult.migrations = $migrationCount
      $app = Start-OwnedNode "app" $appEntry $caseRoot $environment -TypeScript
      $caseProcesses.Add($app)
      $worker = Start-OwnedNode "worker" (Join-Path $workspace "apps\server\src\worker.ts") $caseRoot $environment -TypeScript
      $caseProcesses.Add($worker)
      $healthReady = $false
      for ($attempt = 0; $attempt -lt 120; $attempt++) {
        $app.Process.Refresh(); $worker.Process.Refresh()
        if ($app.Process.HasExited -or $worker.Process.HasExited) { throw "Source app or worker exited during startup; see logs." }
        try {
          $health = Invoke-RestMethod -Uri "$base/healthz" -TimeoutSec 2
          $workerReady = (Get-Content -Raw -LiteralPath (Join-Path $caseRoot "worker.stdout.log")) -match "Worker started"
          if ($health.version -eq "V$packageVersion" -and $workerReady) { $healthReady = $true; break }
        } catch { }
        Start-Sleep -Milliseconds 250
      }
      if (-not $healthReady) { throw "Isolated app/worker readiness timed out; see logs." }
      $caseResult.baseUrl = $base
      $caseResult.database = $databaseName
      Write-Host "Running existing test:e2e-$suite against a fresh migrated local database."
      if ($suite -eq "search") {
        $test = Start-OwnedNode "e2e" (Join-Path $workspace "scripts\test-search-lifecycle-postgres.ts") $caseRoot $environment -TypeScript
      } else {
        $test = Start-OwnedNode "e2e" (Join-Path $workspace "scripts\e2e-$suite.mjs") $caseRoot $environment
      }
      $caseResult.exitCode = Wait-OwnedNode $test
      if ($caseResult.exitCode -eq 0) { $caseResult.status = "passed" }
    } catch {
      $caseResult.error = $_.Exception.Message
    } finally {
      foreach ($owned in $caseProcesses) { Stop-OwnedNode $owned }
      $results.Add([pscustomobject]$caseResult)
      Write-Host "test:e2e-${suite}: $($caseResult.status); logs $caseRoot"
    }
  }
  $allPassed = $results.Count -eq 3 -and @($results | Where-Object status -ne "passed").Count -eq 0
} finally {
  foreach ($owned in $ownedProcesses) {
    try { Stop-OwnedNode $owned } catch { $cleanupErrors.Add($_.Exception.Message) }
  }
  try {
    $ownedContainer = Get-OwnedContainer
    if ($null -ne $ownedContainer) {
      # PostgreSQL writes normal startup messages to stderr. PowerShell 5.1
      # otherwise promotes these records to terminating native-command errors.
      $savedLogPreference = $ErrorActionPreference
      try {
        $ErrorActionPreference = "Continue"
        & docker logs $ownedContainer.Id 2>&1 | ForEach-Object { $_.ToString() } | Set-Content -LiteralPath (Join-Path $runRoot "postgres.log") -Encoding utf8
      } finally { $ErrorActionPreference = $savedLogPreference }
      $null = Invoke-DockerChecked @("rm", "--force", $ownedContainer.Id)
    }
  } catch { $cleanupErrors.Add($_.Exception.Message) }
  [ordered]@{
    runId = $runId; nodeVersion = $nodeVersion
    version = (Get-Content -Raw -LiteralPath (Join-Path $workspace "package.json") | ConvertFrom-Json).version
    completedAt = [DateTimeOffset]::UtcNow.ToString("o"); passed = ($allPassed -and $cleanupErrors.Count -eq 0)
    postgresImage = $image; migrationBaseline = $migrationBaseline
    suites = @($results.ToArray()); cleanupErrors = @($cleanupErrors.ToArray())
  } | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath (Join-Path $runRoot "result.json") -Encoding utf8
}
if (-not $allPassed -or $cleanupErrors.Count -ne 0) {
  throw "Isolated E2E did not pass. Retained evidence: $(Join-Path $runRoot 'result.json')"
}
Write-Host "PASS all three isolated E2E suites. Evidence: $(Join-Path $runRoot 'result.json')"
