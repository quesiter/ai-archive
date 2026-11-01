param([string]$Version = "")

$ErrorActionPreference = "Stop"
$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$syncPackage = Get-Content -LiteralPath (Join-Path $projectRoot "apps\openclaw-sync\package.json") -Raw | ConvertFrom-Json
$expectedVersion = "V$($syncPackage.version)"
if (-not $Version) { $Version = $expectedVersion }
if ($Version -ne $expectedVersion) { throw "Requested version $Version does not match sync source $expectedVersion" }
$stageRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("ai-archive-windows-" + [guid]::NewGuid().ToString("N"))
$stage = Join-Path $stageRoot "ai-conversation-archive-windows-sync"
$archive = Join-Path $projectRoot "release\ai-conversation-archive-windows-sync-$Version.zip"
$releaseRoot = Split-Path -Parent $archive
$temporaryArchive = Join-Path $releaseRoot (".tmp-windows-sync-" + [guid]::NewGuid().ToString("N") + ".zip")

try {
  Push-Location $projectRoot
  try {
    pnpm --filter @ai-archive/contracts build
    if ($LASTEXITCODE -ne 0) { throw "contracts build failed" }
    pnpm --filter @ai-archive/openclaw-sync build
    if ($LASTEXITCODE -ne 0) { throw "sync agent build failed" }
  } finally { Pop-Location }

  New-Item -ItemType Directory -Path $stage -Force | Out-Null
  $windowsGuides = @(Get-ChildItem -LiteralPath (Join-Path $projectRoot "docs") -File |
    Where-Object { $_.Name -like "11-Windows*.md" })
  if ($windowsGuides.Count -ne 1) { throw "Expected exactly one numbered Windows guide" }
  $windowsGuide = $windowsGuides[0]
  $files = @(
    @{ Source = "apps\openclaw-sync\dist\index.cjs"; Target = "openclaw-sync.cjs" },
    @{ Source = "scripts\sync-local-windows-portable.bat"; Target = "sync-local-windows.bat" },
    @{ Source = "scripts\sync-local-windows-core.ps1"; Target = "sync-local-windows-core.ps1" },
    @{ Source = "scripts\repair-windows-sync-pairing.ps1"; Target = "repair-windows-sync-pairing.ps1" },
    @{ Source = "scripts\sync-local-windows-background.ps1"; Target = "sync-local-windows-background.ps1" },
    @{ Source = "scripts\install-windows-sync-task.ps1"; Target = "install-windows-sync-task.ps1" },
    @{ Source = "scripts\uninstall-windows-sync-task.ps1"; Target = "uninstall-windows-sync-task.ps1" }
  )
  foreach ($file in $files) {
    $source = Join-Path $projectRoot $file.Source
    $target = Join-Path $stage $file.Target
    if ([IO.Path]::GetExtension($target) -eq ".ps1") {
      # Windows PowerShell 5.1 reads BOM-less scripts using the system code
      # page. Chinese strings can then become syntax, not just garbled text.
      $content = [IO.File]::ReadAllText($source, [Text.Encoding]::UTF8)
      [IO.File]::WriteAllText($target, $content, (New-Object Text.UTF8Encoding($true)))
      $tokens = $null
      $parseErrors = $null
      $null = [Management.Automation.Language.Parser]::ParseFile($target, [ref]$tokens, [ref]$parseErrors)
      if ($parseErrors.Count -gt 0) {
        throw "PowerShell package validation failed for ${target}: $($parseErrors[0].Message)"
      }
    } else {
      Copy-Item -LiteralPath $source -Destination $target
    }
  }
  Copy-Item -LiteralPath $windowsGuide.FullName -Destination (Join-Path $stage "README.md")
  New-Item -ItemType Directory -Path $releaseRoot -Force | Out-Null
  Compress-Archive -LiteralPath $stage -DestinationPath $temporaryArchive -CompressionLevel Optimal
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $expectedFiles = @{}
  $archiveRootName = Split-Path -Leaf $stage
  foreach ($file in Get-ChildItem -LiteralPath $stage -File -Recurse) {
    $relative = $file.FullName.Substring($stage.Length + 1).Replace("\", "/")
    $expectedFiles["$archiveRootName/$relative"] = $file.FullName
  }
  $seenNames = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
  $seenFiles = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
  $zip = [IO.Compression.ZipFile]::OpenRead($temporaryArchive)
  try {
    foreach ($entry in $zip.Entries) {
      $name = $entry.FullName
      if ($name.Contains("\") -or $name.Contains(":") -or $name.StartsWith("/") -or
          ($name.Split("/") -contains "..") -or -not $seenNames.Add($name.TrimEnd("/"))) {
        throw "Unsafe or duplicate Windows archive path: $name"
      }
      $fileType = ($entry.ExternalAttributes -shr 16) -band 0xF000
      if ($fileType -notin @(0, 0x8000, 0x4000)) { throw "Archive links or special files are not allowed: $name" }
      if ($name.EndsWith("/")) {
        if ($name -ne "$archiveRootName/") { throw "Unexpected Windows archive directory: $name" }
        continue
      }
      if (-not $expectedFiles.ContainsKey($name)) { throw "Unexpected Windows archive file: $name" }
      $null = $seenFiles.Add($name)
      $entryStream = $entry.Open()
      $hash = [Security.Cryptography.SHA256]::Create()
      try {
        $actualHash = [BitConverter]::ToString($hash.ComputeHash($entryStream)).Replace("-", "")
        $sourceStream = [IO.File]::OpenRead($expectedFiles[$name])
        try { $expectedHash = [BitConverter]::ToString($hash.ComputeHash($sourceStream)).Replace("-", "") }
        finally { $sourceStream.Dispose() }
        if ($actualHash -ne $expectedHash) { throw "Windows archive content differs from staged source: $name" }
      } finally {
        $hash.Dispose()
        $entryStream.Dispose()
      }
    }
    if ($seenFiles.Count -ne $expectedFiles.Count) { throw "Windows archive is missing required files" }
  } finally { $zip.Dispose() }
  if (Test-Path -LiteralPath $archive) {
    [IO.File]::Replace($temporaryArchive, $archive, [NullString]::Value)
  } else {
    [IO.File]::Move($temporaryArchive, $archive)
  }
  Write-Host "Created $archive"
} finally {
  if (Test-Path -LiteralPath $temporaryArchive) { Remove-Item -LiteralPath $temporaryArchive -Force }
  $resolvedTemp = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath())
  $resolvedStage = [System.IO.Path]::GetFullPath($stageRoot)
  if (-not $resolvedStage.StartsWith($resolvedTemp, [System.StringComparison]::OrdinalIgnoreCase) -or
      -not (Split-Path -Leaf $resolvedStage).StartsWith("ai-archive-windows-")) {
    throw "Refusing to clean unexpected staging path: $resolvedStage"
  }
  if (Test-Path -LiteralPath $resolvedStage) { Remove-Item -LiteralPath $resolvedStage -Recurse -Force }
}
