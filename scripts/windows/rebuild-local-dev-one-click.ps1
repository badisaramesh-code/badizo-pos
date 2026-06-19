param(
  [switch]$OpenElectron
)

$ErrorActionPreference = 'Stop'

$appRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$backendDir = Join-Path $appRoot 'backend'
$frontendDir = Join-Path $appRoot 'frontend'
$electronDir = Join-Path $appRoot 'electron'
$npmCmd = 'C:\Program Files\nodejs\npm.cmd'

function Write-Step {
  param([string]$Message)
  Write-Host ''
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

function Stop-PortProcess {
  param([int]$Port)

  $connections = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
  $processIds = @($connections | Select-Object -ExpandProperty OwningProcess -Unique)
  foreach ($processId in $processIds) {
    if (!$processId -or $processId -eq 0) {
      continue
    }

    try {
      $process = Get-Process -Id $processId -ErrorAction Stop
      Write-Host "Stopping port $Port process: $($process.ProcessName) ($processId)"
      Stop-Process -Id $processId -Force
    } catch {
      Write-Host "Could not stop process $processId on port $Port. Close it manually if startup fails." -ForegroundColor Yellow
    }
  }
}

function Wait-Url {
  param(
    [string]$Url,
    [int]$Seconds = 45
  )

  for ($i = 0; $i -lt $Seconds; $i++) {
    try {
      $response = Invoke-WebRequest -UseBasicParsing -Uri $Url -TimeoutSec 3
      if ($response.StatusCode -ge 200 -and $response.StatusCode -lt 500) {
        return $true
      }
    } catch {
      Start-Sleep -Seconds 1
    }
  }

  return $false
}

$npm = Resolve-Npm

Write-Host 'Badizo local development restart' -ForegroundColor Green
Write-Host "Using local code from: $appRoot"
Write-Host 'No git pull will be done. Unstaged local changes are included.'

Write-Step 'Installing missing dependencies only'
if (!(Test-Path (Join-Path $backendDir 'node_modules'))) {
  Push-Location $backendDir
  & $npm install
  Pop-Location
}
if (!(Test-Path (Join-Path $frontendDir 'node_modules'))) {
  Push-Location $frontendDir
  & $npm install
  Pop-Location
}
if ($OpenElectron -and !(Test-Path (Join-Path $electronDir 'node_modules'))) {
  Push-Location $electronDir
  & $npm install
  Pop-Location
}

Write-Step 'Building frontend once for packaged/static Electron checks'
Push-Location $frontendDir
$env:REACT_APP_API_BASE_URL = 'http://localhost:5000/api'
& $npm run build
Pop-Location

Write-Step 'Stopping old local backend/frontend processes'
Stop-PortProcess -Port 3000
Stop-PortProcess -Port 5000
Start-Sleep -Seconds 2

Write-Step 'Starting backend on http://localhost:5000'
Start-Process -WindowStyle Hidden -FilePath $npm -ArgumentList 'run','start' -WorkingDirectory $backendDir
if (!(Wait-Url -Url 'http://localhost:5000/api/health' -Seconds 45)) {
  throw 'Backend did not become healthy on http://localhost:5000/api/health'
}

Write-Step 'Starting frontend dev server on http://localhost:3000'
$frontendCommand = '$env:BROWSER=''none''; npm run start'
Start-Process -WindowStyle Hidden -FilePath powershell.exe -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-Command',$frontendCommand -WorkingDirectory $frontendDir
if (!(Wait-Url -Url 'http://localhost:3000' -Seconds 90)) {
  throw 'Frontend did not open on http://localhost:3000'
}

Write-Step 'Opening browser'
Start-Process 'http://localhost:3000'

if ($OpenElectron) {
  Write-Step 'Opening Electron from this repo'
  Start-Process -FilePath $npm -ArgumentList 'run','start' -WorkingDirectory $electronDir
}

Write-Host ''
Write-Host 'Local development app is ready.' -ForegroundColor Green
Write-Host 'Browser:  http://localhost:3000'
Write-Host 'Backend:  http://localhost:5000/api/health'
