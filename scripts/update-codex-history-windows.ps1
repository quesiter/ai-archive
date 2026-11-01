param([switch]$DryRun)

$ErrorActionPreference = "Stop"
$archiveStage = $PSScriptRoot
$archiveIdentity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
$archiveCurrentSid = $archiveIdentity.User.Value
function Get-ArchiveNodePattern([string]$Agent) {
  return '^(?:"[^"]+"|\S+)\s+(?:"' + [regex]::Escape($Agent) + '"|' + [regex]::Escape($Agent) + ')(?=\s|$)'
}
function Stop-ArchiveAgentProcesses([string[]]$Agents) {
  if (-not $Agents.Count) { return }
  foreach ($archiveProcess in @(Get-CimInstance Win32_Process -Filter "Name='node.exe'")) {
    foreach ($archiveAgent in $Agents) {
      if ($archiveProcess.CommandLine -match (Get-ArchiveNodePattern $archiveAgent)) {
        $archiveOwner = Invoke-CimMethod -InputObject $archiveProcess -MethodName GetOwnerSid -ErrorAction SilentlyContinue
        if ($archiveOwner.Sid -eq $archiveCurrentSid) { Stop-Process -Id $archiveProcess.ProcessId -ErrorAction SilentlyContinue }
        break
      }
    }
  }
}
$archiveNode = Get-Command node -ErrorAction SilentlyContinue
if (-not $archiveNode) { throw "未找到 Node.js。请先安装 Node.js 22 或 24 LTS，再双击运行。" }
$archiveNodeMajor = [int](& $archiveNode.Source -p "process.versions.node.split('.')[0]")
if ($archiveNodeMajor -lt 22) { throw "需要 Node.js 22 或更新版本。" }
$archiveConfig = $env:AI_ARCHIVE_SYNC_CONFIG
if ([string]::IsNullOrWhiteSpace($archiveConfig)) {
  $archivePreviousTask = Get-ScheduledTask -TaskPath '\' -TaskName 'AI Archive Local Sync' -ErrorAction SilentlyContinue
  if ($archivePreviousTask) {
    $archivePreviousUser = $archivePreviousTask.Principal.UserId
    $archivePreviousSid = if ($archivePreviousUser -match '^S-1-') { $archivePreviousUser } else {
      (New-Object System.Security.Principal.NTAccount($archivePreviousUser)).Translate([System.Security.Principal.SecurityIdentifier]).Value
    }
    if ($archivePreviousSid -eq $archiveCurrentSid) {
      foreach ($archivePreviousAction in $archivePreviousTask.Actions) {
        if ($archivePreviousAction.Arguments -match '(?i)-File\s+"([^"]*company-sync-background\.ps1)"') {
          $archivePreviousRunner = $Matches[1]
          if (Test-Path -LiteralPath $archivePreviousRunner -PathType Leaf) {
            $archivePreviousText = Get-Content -LiteralPath $archivePreviousRunner -Raw -Encoding UTF8
            if ($archivePreviousText -match '(?m)^\$env:AI_ARCHIVE_SYNC_CONFIG = ''((?:[^'']|'''')*)''\r?$') {
              $archiveConfig = $Matches[1].Replace("''", "'")
            }
          }
        }
      }
    }
  }
}
if ([string]::IsNullOrWhiteSpace($archiveConfig)) {
  $archiveConfig = Join-Path $env:USERPROFILE '.config\ai-archive\openclaw-sync.json'
}
if (-not (Test-Path -LiteralPath $archiveConfig -PathType Leaf)) {
  throw "未找到已有配对配置。请用公司电脑平时运行 Codex 的 Windows 账号执行；配置路径：$archiveConfig"
}
$archiveConfig = (Resolve-Path -LiteralPath $archiveConfig).Path
$env:AI_ARCHIVE_SYNC_CONFIG = $archiveConfig
$archiveHelper = Join-Path $archiveStage 'repair-codex-history.cjs'

if ($DryRun) {
  & $archiveNode.Source $archiveHelper --dry-run
  if ($LASTEXITCODE -ne 0) { throw "历史扫描检查失败。" }
  exit 0
}

$archiveBase = Join-Path $env:LOCALAPPDATA 'AIArchive'
$archiveRunId = (Get-Date -Format 'yyyyMMdd-HHmmss') + '-' + [guid]::NewGuid().ToString('N').Substring(0, 8)
$archiveBackup = Join-Path $archiveBase "UpgradeBackups\$archiveRunId"
New-Item -ItemType Directory -Path $archiveBackup -Force | Out-Null
$archiveLog = Join-Path $archiveBackup 'update.log'
$archiveReport = Join-Path $archiveBackup 'repair-result.json'
$archiveTranscriptStarted = $false
$archiveTaskName = 'AI Archive Local Sync'
$archiveOldTask = $null
$archiveOldXml = $null
$archiveTaskChanged = $false
$archiveOldWasRunning = $false
$archiveExpectedAgent = $null
try {
  Start-Transcript -LiteralPath $archiveLog | Out-Null
  $archiveTranscriptStarted = $true
  Write-Host '正在扫描本机全部 Codex 历史，只补齐父子关系。'
  & $archiveNode.Source $archiveHelper --report $archiveReport
  if ($LASTEXITCODE -ne 0) { throw "历史关系补齐失败，后台程序未更新。" }
  $archiveResult = Get-Content -LiteralPath $archiveReport -Raw -Encoding UTF8 | ConvertFrom-Json
  Write-Host ("扫描 {0} 个文件；新增关系 {1} 条，已有正确关系 {2} 条，未归档跳过 {3} 条。" -f $archiveResult.files, $archiveResult.updated, $archiveResult.unchanged, $archiveResult.notFound)

  $archiveOldTask = Get-ScheduledTask -TaskPath '\' -TaskName $archiveTaskName -ErrorAction SilentlyContinue
  $archiveOldAgentPaths = @()
  if ($archiveOldTask) {
    $archiveTaskUser = $archiveOldTask.Principal.UserId
    $archiveTaskSid = if ($archiveTaskUser -match '^S-1-') { $archiveTaskUser } else {
      (New-Object System.Security.Principal.NTAccount($archiveTaskUser)).Translate([System.Security.Principal.SecurityIdentifier]).Value
    }
    if ($archiveTaskSid -ne $archiveCurrentSid) { throw "历史关系已补齐；现有同步任务属于其他 Windows 账号，未更改该任务。" }
    foreach ($archiveAction in $archiveOldTask.Actions) {
      if ($archiveAction.Arguments -notmatch '(?i)-File\s+(?:"([^"]+)"|(\S+))') {
        throw "历史关系已补齐；现有同步任务使用自定义启动方式，未更改该任务。"
      }
      $archiveOldRunner = if ($Matches[1]) { $Matches[1] } else { $Matches[2] }
      if ((Split-Path -Leaf $archiveOldRunner) -notin @('sync-local-windows-background.ps1', 'company-sync-background.ps1')) {
        throw "历史关系已补齐；现有同步任务使用自定义脚本，未更改该任务。"
      }
      $archiveOldFolder = Split-Path -Parent $archiveOldRunner
      foreach ($archiveCandidate in @((Join-Path $archiveOldFolder 'openclaw-sync.cjs'), (Join-Path (Split-Path -Parent $archiveOldFolder) 'apps\openclaw-sync\dist\index.cjs'))) {
        if (Test-Path -LiteralPath $archiveCandidate -PathType Leaf) { $archiveOldAgentPaths += (Resolve-Path -LiteralPath $archiveCandidate).Path }
      }
    }
    $archiveOldXml = Export-ScheduledTask -TaskPath '\' -TaskName $archiveTaskName
    $archiveOldXml | Set-Content -LiteralPath (Join-Path $archiveBackup 'scheduled-task.xml') -Encoding UTF8
    $archiveOldWasRunning = $archiveOldTask.State -eq 'Running'
  }

  # A unique permanent install keeps a running older installation untouched.
  $archiveInstall = Join-Path $archiveBase "LocalSync\V2.3.3-$archiveRunId"
  $archiveExpectedAgent = Join-Path $archiveInstall 'openclaw-sync.cjs'
  New-Item -ItemType Directory -Path $archiveInstall -Force | Out-Null
  foreach ($archiveFile in @('openclaw-sync.cjs', 'sync-local-windows-background.ps1', 'install-windows-sync-task.ps1')) {
    Copy-Item -LiteralPath (Join-Path $archiveStage $archiveFile) -Destination (Join-Path $archiveInstall $archiveFile)
  }
  $archiveRunner = Join-Path $archiveInstall 'company-sync-background.ps1'
  $archiveEscapedConfig = $archiveConfig.Replace("'", "''")
  $archiveEscapedNodeFolder = (Split-Path -Parent $archiveNode.Source).Replace("'", "''")
  @"
`$env:AI_ARCHIVE_SYNC_CONFIG = '$archiveEscapedConfig'
`$env:PATH = '$archiveEscapedNodeFolder;' + `$env:PATH
& (Join-Path `$PSScriptRoot 'sync-local-windows-background.ps1')
exit `$LASTEXITCODE
"@ | Set-Content -LiteralPath $archiveRunner -Encoding UTF8

  if ($archiveOldTask) {
    $archiveTaskChanged = $true
    Stop-ScheduledTask -TaskPath '\' -TaskName $archiveTaskName
    Stop-ArchiveAgentProcesses $archiveOldAgentPaths
  }
  $archiveState = Join-Path (Split-Path -Parent $archiveConfig) 'openclaw-sync-state.json'
  if (Test-Path -LiteralPath $archiveState -PathType Leaf) {
    Copy-Item -LiteralPath $archiveState -Destination (Join-Path $archiveBackup 'openclaw-sync-state.json')
  }
  $archiveTaskChanged = $true
  $archiveAction = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$archiveRunner`""
  $archiveTrigger = New-ScheduledTaskTrigger -AtLogOn -User $archiveIdentity.Name
  $archiveSettings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Seconds 0)
  $archivePrincipal = New-ScheduledTaskPrincipal -UserId ([System.Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType Interactive -RunLevel Limited
  Register-ScheduledTask -TaskPath '\' -TaskName $archiveTaskName -Action $archiveAction -Trigger $archiveTrigger -Settings $archiveSettings -Principal $archivePrincipal -Description 'Zhiyan Guicang local conversation sync after user logon.' -Force | Out-Null
  Start-ScheduledTask -TaskPath '\' -TaskName $archiveTaskName
  $archiveSavedTask = Get-ScheduledTask -TaskPath '\' -TaskName $archiveTaskName
  if ($archiveSavedTask.Actions.Arguments -notmatch [regex]::Escape($archiveRunner)) { throw "后台任务路径核验失败。" }
  $archiveStarted = $false
  for ($archiveAttempt = 0; $archiveAttempt -lt 20; $archiveAttempt++) {
    Start-Sleep -Milliseconds 500
    $archiveRunning = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object {
      $_.CommandLine -match (Get-ArchiveNodePattern $archiveExpectedAgent)
    })
    if ($archiveRunning.Count -gt 0) { $archiveStarted = $true; break }
  }
  if (-not $archiveStarted) { throw "后台任务未能启动同步进程，历史关系已经补齐。" }
  Write-Host '完成：历史关系已更新，V2.3.3 后台同步已安装并启动。' -ForegroundColor Green
  Write-Host '消息和版本均保留。请刷新归档网页查看结果。'
  Write-Host "安装目录：$archiveInstall"
  Write-Host "更新记录：$archiveBackup"
} catch {
  $archiveFailure = $_.Exception.Message
  if ($archiveTaskChanged -and $archiveExpectedAgent) {
    Stop-ScheduledTask -TaskPath '\' -TaskName $archiveTaskName -ErrorAction SilentlyContinue
    Stop-ArchiveAgentProcesses @($archiveExpectedAgent)
  }
  if ($archiveTaskChanged -and $archiveOldXml) {
    try {
      Stop-ScheduledTask -TaskPath '\' -TaskName $archiveTaskName -ErrorAction SilentlyContinue
      Register-ScheduledTask -TaskPath '\' -TaskName $archiveTaskName -Xml $archiveOldXml -Force | Out-Null
      if ($archiveOldWasRunning) { Start-ScheduledTask -TaskPath '\' -TaskName $archiveTaskName }
      Write-Host '已恢复原来的后台同步任务。'
    } catch { Write-Host "恢复后台任务失败，可使用备份：$archiveBackup" }
  } elseif ($archiveTaskChanged) {
    Stop-ScheduledTask -TaskPath '\' -TaskName $archiveTaskName -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskPath '\' -TaskName $archiveTaskName -Confirm:$false -ErrorAction SilentlyContinue
  }
  Write-Host $archiveFailure -ForegroundColor Red
  Write-Host "更新日志：$archiveLog"
  exit 1
} finally {
  if ($archiveTranscriptStarted) { Stop-Transcript | Out-Null }
}
