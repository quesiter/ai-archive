param([string]$Version = "V2.3.0")

$ErrorActionPreference = "Stop"
$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$stageRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("ai-archive-windows-" + [guid]::NewGuid().ToString("N"))
$stage = Join-Path $stageRoot "ai-conversation-archive-windows-sync"
$archive = Join-Path $projectRoot "release\ai-conversation-archive-windows-sync-$Version.zip"

try {
  Push-Location $projectRoot
  try {
    pnpm --filter @ai-archive/contracts build
    if ($LASTEXITCODE -ne 0) { throw "contracts build failed" }
    pnpm --filter @ai-archive/openclaw-sync build
    if ($LASTEXITCODE -ne 0) { throw "sync agent build failed" }
  } finally { Pop-Location }

  New-Item -ItemType Directory -Path $stage -Force | Out-Null
  $windowsGuide = Get-ChildItem -LiteralPath (Join-Path $projectRoot "docs") -File |
    Where-Object { $_.Name -like "11-Windows*.md" } |
    Select-Object -First 1
  if (-not $windowsGuide) { throw "Numbered Windows guide was not found" }
  $files = @(
    @{ Source = "apps\openclaw-sync\dist\index.cjs"; Target = "openclaw-sync.cjs" },
    @{ Source = "scripts\sync-local-windows-portable.bat"; Target = "sync-local-windows.bat" },
    @{ Source = "scripts\sync-local-windows-core.ps1"; Target = "sync-local-windows-core.ps1" },
    @{ Source = "scripts\sync-local-windows-background.ps1"; Target = "sync-local-windows-background.ps1" },
    @{ Source = "scripts\install-windows-sync-task.ps1"; Target = "install-windows-sync-task.ps1" },
    @{ Source = "scripts\uninstall-windows-sync-task.ps1"; Target = "uninstall-windows-sync-task.ps1" }
  )
  foreach ($file in $files) {
    Copy-Item -LiteralPath (Join-Path $projectRoot $file.Source) -Destination (Join-Path $stage $file.Target)
  }
  Copy-Item -LiteralPath $windowsGuide.FullName -Destination (Join-Path $stage "README.md")
  if (Test-Path -LiteralPath $archive) { Remove-Item -LiteralPath $archive }
  Compress-Archive -LiteralPath $stage -DestinationPath $archive -CompressionLevel Optimal
  Write-Host "Created $archive"
} finally {
  $resolvedTemp = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath())
  $resolvedStage = [System.IO.Path]::GetFullPath($stageRoot)
  if (-not $resolvedStage.StartsWith($resolvedTemp, [System.StringComparison]::OrdinalIgnoreCase) -or
      -not (Split-Path -Leaf $resolvedStage).StartsWith("ai-archive-windows-")) {
    throw "Refusing to clean unexpected staging path: $resolvedStage"
  }
  if (Test-Path -LiteralPath $resolvedStage) { Remove-Item -LiteralPath $resolvedStage -Recurse -Force }
}
