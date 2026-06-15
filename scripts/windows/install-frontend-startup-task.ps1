param(
  [string]$ServerIp = ''
)

$ErrorActionPreference = 'Stop'

$taskName = 'Badizo POS Frontend'
$appRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$frontendDir = Join-Path $appRoot 'frontend'
$npmCmd = 'C:\Program Files\nodejs\npm.cmd'
$powerShell = "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe"

function Get-ServerIp {
  $addresses = Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
    Where-Object {
      $_.IPAddress -notlike '127.*' -and
      $_.IPAddress -notlike '169.254.*' -and
      $_.PrefixOrigin -ne 'WellKnown'
    } |
    Select-Object -ExpandProperty IPAddress

  if (!$addresses -or $addresses.Count -eq 0) {
    throw 'Unable to auto-detect server IP. Run this script with -ServerIp 192.168.x.x'
  }

  return @($addresses)[0]
}

if ([string]::IsNullOrWhiteSpace($ServerIp)) {
  $ServerIp = Get-ServerIp
}

if (!(Test-Path $npmCmd)) {
  $command = Get-Command npm.cmd -ErrorAction SilentlyContinue
  if (!$command) {
    throw 'npm.cmd was not found. Install Node.js first.'
  }
  $npmCmd = $command.Source
}

$taskCommand = "Set-Location '$frontendDir'; `$env:REACT_APP_API_BASE_URL='http://$ServerIp`:5000/api'; & '$npmCmd' start"

$action = New-ScheduledTaskAction `
  -Execute $powerShell `
  -Argument "-NoProfile -ExecutionPolicy Bypass -Command `"$taskCommand`""

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
  -Description 'Starts the Badizo POS frontend automatically after Windows starts.' `
  -Force | Out-Null

Start-ScheduledTask -TaskName $taskName
Write-Host "Installed and started scheduled task: $taskName"
Write-Host "Frontend API target: http://$ServerIp`:5000/api"
