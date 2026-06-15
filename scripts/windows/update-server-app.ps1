param(
  [string]$ServerIp = '',
  [switch]$SkipGitPull,
  [switch]$SkipInstall,
  [switch]$SkipBackendRestart,
  [switch]$RestartFrontendTask
)

$ErrorActionPreference = 'Stop'

$appRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$backendDir = Join-Path $appRoot 'backend'
$frontendDir = Join-Path $appRoot 'frontend'
$npmCmd = 'C:\Program Files\nodejs\npm.cmd'

function Write-Step {
  param([string]$Message)
  Write-Host ""
  Write-Host "== $Message ==" -ForegroundColor Cyan
}

function Resolve-Npm {
  if (Test-Path $npmCmd) {
    return $npmCmd
  }
  $command = Get-Command npm.cmd -ErrorAction SilentlyContinue
  if (!$command) {
    throw 'npm.cmd was not found. Install Node.js first.'
  }
  return $command.Source
}

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

$npm = Resolve-Npm
if ([string]::IsNullOrWhiteSpace($ServerIp)) {
  $ServerIp = Get-ServerIp
}

Write-Host "Badizo server IP: $ServerIp" -ForegroundColor Green
Write-Host "App root: $appRoot"

if (!$SkipGitPull) {
  Write-Step 'Pulling latest code'
  Push-Location $appRoot
  git pull
  Pop-Location
}

if (!$SkipInstall) {
  Write-Step 'Installing backend dependencies'
  Push-Location $backendDir
  & $npm install
  Pop-Location

  Write-Step 'Installing frontend dependencies'
  Push-Location $frontendDir
  & $npm install
  Pop-Location
}

Write-Step 'Building frontend'
Push-Location $frontendDir
$env:REACT_APP_API_BASE_URL = "http://$ServerIp`:5000/api"
& $npm run build
Pop-Location

if (!$SkipBackendRestart) {
  Write-Step 'Restarting backend'
  $backendTask = Get-ScheduledTask -TaskName 'Badizo POS Backend' -ErrorAction SilentlyContinue
  if ($backendTask) {
    Stop-ScheduledTask -TaskName 'Badizo POS Backend' -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 2
    Start-ScheduledTask -TaskName 'Badizo POS Backend'
  } else {
    & (Join-Path $PSScriptRoot 'start-backend.ps1')
  }
}

if ($RestartFrontendTask) {
  Write-Step 'Restarting frontend task'
  $frontendTask = Get-ScheduledTask -TaskName 'Badizo POS Frontend' -ErrorAction SilentlyContinue
  if ($frontendTask) {
    Stop-ScheduledTask -TaskName 'Badizo POS Frontend' -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 2
    Start-ScheduledTask -TaskName 'Badizo POS Frontend'
  } else {
    Write-Host 'Frontend task not found. Run install-frontend-startup-task.ps1 if you use npm-start frontend hosting.' -ForegroundColor Yellow
  }
}

Write-Step 'Checking ports'
$backendPort = Test-NetConnection localhost -Port 5000 -WarningAction SilentlyContinue
Write-Host "Backend 5000: $($backendPort.TcpTestSucceeded)"
if ($RestartFrontendTask) {
  $frontendPort = Test-NetConnection localhost -Port 3000 -WarningAction SilentlyContinue
  Write-Host "Frontend 3000: $($frontendPort.TcpTestSucceeded)"
}

Write-Host ""
Write-Host 'Server update complete.' -ForegroundColor Green
Write-Host "Frontend build API target: http://$ServerIp`:5000/api"
