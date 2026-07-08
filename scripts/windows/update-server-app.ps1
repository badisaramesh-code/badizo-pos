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

function Test-BackendHealth {
  try {
    $response = Invoke-WebRequest -UseBasicParsing -Uri 'http://localhost:5000/api/health' -TimeoutSec 3
    return $response.StatusCode -eq 200
  } catch {
    return $false
  }
}

function Wait-BackendHealth {
  param([int]$Seconds = 20)

  for ($i = 0; $i -lt $Seconds; $i++) {
    if (Test-BackendHealth) {
      return $true
    }
    Start-Sleep -Seconds 1
  }

  return $false
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
$previousApiBaseUrl = $env:REACT_APP_API_BASE_URL
$previousSkipOpenAfterBuild = $env:BADIZO_SKIP_OPEN_AFTER_BUILD
try {
  $env:REACT_APP_API_BASE_URL = "http://$ServerIp`:5000/api"
  $env:BADIZO_SKIP_OPEN_AFTER_BUILD = '1'
  & $npm run build
} finally {
  $env:REACT_APP_API_BASE_URL = $previousApiBaseUrl
  $env:BADIZO_SKIP_OPEN_AFTER_BUILD = $previousSkipOpenAfterBuild
  Pop-Location
}

if (!$SkipBackendRestart) {
  Write-Step 'Restarting backend'
  $backendTask = Get-ScheduledTask -TaskName 'Badizo POS Backend' -ErrorAction SilentlyContinue
  if ($backendTask) {
    Stop-ScheduledTask -TaskName 'Badizo POS Backend' -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 2
    Start-ScheduledTask -TaskName 'Badizo POS Backend'
    if (!(Wait-BackendHealth -Seconds 20)) {
      Write-Host 'Scheduled task did not make backend healthy. Starting backend directly once.' -ForegroundColor Yellow
      & (Join-Path $PSScriptRoot 'start-backend.ps1')
    }
  } else {
    Write-Host 'Backend scheduled task not found. Starting backend directly once.' -ForegroundColor Yellow
    & (Join-Path $PSScriptRoot 'start-backend.ps1')
  }

  if (!(Wait-BackendHealth -Seconds 20)) {
    throw 'Backend is still not reachable on port 5000. Run scripts\windows\install-backend-startup-task.ps1 from Administrator PowerShell, then run this update script again.'
  }
}

if ($RestartFrontendTask) {
  Write-Host 'Frontend is served by backend port 5000; separate frontend task restart is no longer needed.' -ForegroundColor Yellow
}

Write-Step 'Checking ports'
$backendPort = Test-NetConnection localhost -Port 5000 -WarningAction SilentlyContinue
Write-Host "Backend 5000: $($backendPort.TcpTestSucceeded)"
if (!$backendPort.TcpTestSucceeded) {
  throw 'Backend port 5000 is not reachable. The update did not fully complete.'
}

Write-Host ""
Write-Host 'Server update complete.' -ForegroundColor Green
Write-Host "Frontend build API target: http://$ServerIp`:5000/api"
