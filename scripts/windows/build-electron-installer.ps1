param(
  [string]$ServerIp = '',
  [switch]$SkipFrontendBuild,
  [switch]$SkipInstall
)

$ErrorActionPreference = 'Stop'

$appRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$frontendDir = Join-Path $appRoot 'frontend'
$electronDir = Join-Path $appRoot 'electron'
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

if (!$SkipFrontendBuild) {
  if (!$SkipInstall) {
    Write-Step 'Installing frontend dependencies'
    Push-Location $frontendDir
    & $npm install
    Pop-Location
  }

  Write-Step 'Building frontend for server API'
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
}

if (!$SkipInstall) {
  Write-Step 'Installing Electron dependencies'
  Push-Location $electronDir
  & $npm install
  Pop-Location
}

Write-Step 'Building Electron installer'
Push-Location $electronDir
& $npm run dist
Pop-Location

Write-Host ""
Write-Host 'Electron installer ready:' -ForegroundColor Green
Get-ChildItem (Join-Path $electronDir 'dist') -Filter '*.exe' |
  Sort-Object LastWriteTime -Descending |
  Select-Object -First 3 Name,Length,LastWriteTime |
  Format-Table -AutoSize
