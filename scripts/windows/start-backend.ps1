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

if (!(Test-Path $nodeExe)) {
  $nodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue
  if (!$nodeCommand) {
    Write-BackendLog 'Node.js was not found. Install Node.js 20 LTS.'
    exit 1
  }
  $nodeExe = $nodeCommand.Source
}

$createdNew = $false
$watchdogMutex = New-Object System.Threading.Mutex($true, 'Local\BadizoPOSBackendWatchdog', [ref]$createdNew)
if (!$createdNew) {
  Write-BackendLog 'Backend watchdog is already running.'
  exit 0
}

function Start-BadizoBackend {
  Write-BackendLog "Starting backend from $backendDir with $nodeExe"
  $processInfo = New-Object System.Diagnostics.ProcessStartInfo
  $processInfo.FileName = $nodeExe
  $processInfo.Arguments = 'server.js'
  $processInfo.WorkingDirectory = $backendDir
  $processInfo.UseShellExecute = $false
  $processInfo.CreateNoWindow = $true
  $process = New-Object System.Diagnostics.Process
  $process.StartInfo = $processInfo
  [void]$process.Start()

  for ($attempt = 1; $attempt -le 15; $attempt++) {
    Start-Sleep -Seconds 1
    if (Test-BackendHealth) {
      Write-BackendLog "Backend healthy. PID=$($process.Id)"
      return $true
    }
  }

  Write-BackendLog 'Backend did not become healthy; watchdog will retry.'
  return $false
}

try {
  Write-BackendLog 'Backend watchdog started.'
  while ($true) {
    if (!(Test-BackendHealth)) {
      [void](Start-BadizoBackend)
    }
    Start-Sleep -Seconds 10
  }
} finally {
  if ($watchdogMutex) {
    $watchdogMutex.ReleaseMutex()
    $watchdogMutex.Dispose()
  }
}
