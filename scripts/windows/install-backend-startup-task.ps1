$ErrorActionPreference = 'Stop'

$taskName = 'Badizo POS Backend'
$scriptPath = Join-Path $PSScriptRoot 'start-backend.ps1'
$powerShell = "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe"

if (!(Test-Path $scriptPath)) {
  throw "Cannot find $scriptPath"
}

$action = New-ScheduledTaskAction `
  -Execute $powerShell `
  -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$scriptPath`""

$trigger = New-ScheduledTaskTrigger -AtStartup
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Highest
$settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -ExecutionTimeLimit (New-TimeSpan -Hours 0) `
  -RestartCount 3 `
  -RestartInterval (New-TimeSpan -Minutes 1)

Register-ScheduledTask `
  -TaskName $taskName `
  -Action $action `
  -Trigger $trigger `
  -Principal $principal `
  -Settings $settings `
  -Description 'Starts the Badizo POS backend automatically after Windows starts.' `
  -Force | Out-Null

Start-ScheduledTask -TaskName $taskName
Write-Host "Installed and started scheduled task: $taskName"
