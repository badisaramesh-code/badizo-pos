$ErrorActionPreference = 'Stop'

$appRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$frontendDir = Join-Path $appRoot 'frontend'
$serverScript = Join-Path $PSScriptRoot 'serve-frontend-build.js'
$logDir = Join-Path $frontendDir 'logs'
$logFile = Join-Path $logDir 'frontend-startup.log'
$outFile = Join-Path $logDir 'frontend-server.out.log'
$errFile = Join-Path $logDir 'frontend-server.err.log'
$nodeExe = 'C:\Program Files\nodejs\node.exe'

New-Item -ItemType Directory -Force -Path $logDir | Out-Null

function Write-FrontendLog {
  param([string]$Message)
  Add-Content -Path $logFile -Value "$(Get-Date -Format s) $Message"
}

function Test-FrontendHealth {
  $client = $null
  try {
    $client = New-Object System.Net.Sockets.TcpClient
    $result = $client.BeginConnect('127.0.0.1', 3000, $null, $null)
    if (!$result.AsyncWaitHandle.WaitOne(3000, $false)) {
      return $false
    }
    $client.EndConnect($result)
    return $true
  } catch {
    return $false
  } finally {
    if ($client) {
      $client.Close()
    }
  }
}

if (Test-FrontendHealth) {
  Write-FrontendLog 'Frontend already running on port 3000.'
  exit 0
}

if (!(Test-Path $serverScript)) {
  Write-FrontendLog "Frontend server script was not found: $serverScript"
  exit 1
}

if (!(Test-Path $nodeExe)) {
  $nodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue
  if (!$nodeCommand) {
    Write-FrontendLog 'Node.js was not found. Install Node.js first.'
    exit 1
  }
  $nodeExe = $nodeCommand.Source
}

Write-FrontendLog "Starting frontend static server from $frontendDir with $nodeExe"
Set-Location $appRoot
& $nodeExe $serverScript >> $outFile 2>> $errFile
