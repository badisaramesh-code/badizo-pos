$ErrorActionPreference = 'Stop'

$appRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$backendDir = Join-Path $appRoot 'backend'
$logDir = Join-Path $backendDir 'logs'
$logFile = Join-Path $logDir 'backend-startup.log'
$nodeExe = 'C:\Program Files\nodejs\node.exe'

New-Item -ItemType Directory -Force -Path $logDir | Out-Null

function Write-BackendLog {
  param([string]$Message)
  Add-Content -Path $logFile -Value "$(Get-Date -Format s) $Message"
}

function Test-BackendHealth {
  try {
    $response = Invoke-WebRequest -UseBasicParsing -Uri 'http://localhost:5000/api/health' -TimeoutSec 3
    return $response.StatusCode -eq 200
  } catch {
    return $false
  }
}

if (Test-BackendHealth) {
  Write-BackendLog 'Backend already running on port 5000.'
  exit 0
}

if (!(Test-Path $nodeExe)) {
  $nodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue
  if (!$nodeCommand) {
    Write-BackendLog 'Node.js was not found. Install Node.js 20 LTS.'
    exit 1
  }
  $nodeExe = $nodeCommand.Source
}

Write-BackendLog "Starting backend from $backendDir with $nodeExe"
Start-Process `
  -FilePath $nodeExe `
  -ArgumentList 'server.js' `
  -WorkingDirectory $backendDir `
  -WindowStyle Hidden `
  -RedirectStandardOutput (Join-Path $logDir 'backend.out.log') `
  -RedirectStandardError (Join-Path $logDir 'backend.err.log')

Start-Sleep -Seconds 5

if (Test-BackendHealth) {
  Write-BackendLog 'Backend started successfully.'
  exit 0
}

Write-BackendLog 'Backend did not respond after startup. Check backend.err.log.'
exit 1
