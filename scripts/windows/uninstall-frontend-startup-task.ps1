$ErrorActionPreference = 'Stop'

$taskName = 'Badizo POS Frontend'
$task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue

if (!$task) {
  Write-Host "Scheduled task not found: $taskName"
  exit 0
}

Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
Write-Host "Removed scheduled task: $taskName"

