param(
  [string]$ServerIp = ''
)

$ErrorActionPreference = 'Stop'

$taskName = 'Badizo POS Frontend'
$appRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$frontendBuild = Join-Path $appRoot 'frontend\build\index.html'
$scriptPath = Join-Path $PSScriptRoot 'start-frontend.ps1'
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

if (!(Test-Path $scriptPath)) {
  throw "Cannot find $scriptPath"
}

if (!(Test-Path $frontendBuild)) {
  throw "Frontend production build was not found: $frontendBuild. Run update-server-app.ps1 or setup-server-lan-one-click.ps1 first."
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

function Register-FrontendTask {
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
  $startupPrincipal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Highest
  Register-FrontendTask `
    -Trigger $startupTrigger `
    -Principal $startupPrincipal `
    -Description 'Serves the Badizo POS production frontend automatically after Windows starts.'
} catch {
  Write-Host 'Administrator permission was not available for a startup task. Creating a login task for the current Windows user instead.' -ForegroundColor Yellow
  $logonTrigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
  $logonPrincipal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited
  Register-FrontendTask `
    -Trigger $logonTrigger `
    -Principal $logonPrincipal `
    -Description 'Serves the Badizo POS production frontend when the server user logs in.'
}

Start-ScheduledTask -TaskName $taskName
Write-Host "Installed and started scheduled task: $taskName"
Write-Host "Frontend API target: http://$ServerIp`:5000/api"
