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

$settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -ExecutionTimeLimit (New-TimeSpan -Hours 0) `
  -RestartCount 3 `
  -RestartInterval (New-TimeSpan -Minutes 1)

function Register-BackendTask {
  param(
    [Microsoft.Management.Infrastructure.CimInstance]$Trigger,
    [Microsoft.Management.Infrastructure.CimInstance]$Principal,
    [string]$Description
  )

  Register-ScheduledTask `
    -TaskName $taskName `
    -Action $action `
    -Trigger $Trigger `
    -Principal $Principal `
    -Settings $settings `
    -Description $Description `
    -Force | Out-Null
}

try {
  $startupTrigger = New-ScheduledTaskTrigger -AtStartup
  $startupPrincipal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
  Register-BackendTask `
    -Trigger $startupTrigger `
    -Principal $startupPrincipal `
    -Description 'Starts the Badizo POS backend automatically after Windows starts, even before the server user logs in.'
} catch {
  Write-Host 'Administrator permission was not available for a startup task. Creating a login task for the current Windows user instead.' -ForegroundColor Yellow
  $logonTrigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
  $logonPrincipal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited
  Register-BackendTask `
    -Trigger $logonTrigger `
    -Principal $logonPrincipal `
    -Description 'Starts the Badizo POS backend when the server user logs in.'
}

Start-ScheduledTask -TaskName $taskName
Write-Host "Installed and started scheduled task: $taskName"
