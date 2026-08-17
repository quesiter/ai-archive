param(
  [string]$TaskName = "AI Archive Local Sync"
)

$ErrorActionPreference = "Stop"

$task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($task) {
  Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
  Write-Host "Uninstalled scheduled task: $TaskName"
} else {
  Write-Host "Scheduled task was not installed: $TaskName"
}
