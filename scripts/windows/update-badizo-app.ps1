param(
  [string]$ServerIp = '',
  [switch]$BuildElectron,
  [switch]$SkipGitPull,
  [switch]$SkipInstall,
  [switch]$RestartFrontendTask
)

$ErrorActionPreference = 'Stop'

$appRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$backendTaskName = 'Badizo POS Backend'

function Write-Step {
  param([string]$Message)
  Write-Host ''
  Write-Host "== $Message ==" -ForegroundColor Cyan
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

try {
  Write-Host 'Badizo POS all-in-one update' -ForegroundColor Green
  Write-Host "App root: $appRoot"

  Write-Step 'Ensuring backend startup task exists'
  $backendTask = Get-ScheduledTask -TaskName $backendTaskName -ErrorAction SilentlyContinue
  if (!$backendTask) {
    Write-Host 'Backend startup task not found. Installing it now.'
    try {
      & (Join-Path $PSScriptRoot 'install-backend-startup-task.ps1')
    } catch {
      Write-Host 'Could not create backend startup task from this PowerShell session.' -ForegroundColor Yellow
      Write-Host 'Continuing with update. Later, run this script from Administrator PowerShell to make startup automatic.' -ForegroundColor Yellow
    }
  } else {
    Write-Host "Backend startup task already exists: $backendTaskName"
  }

  Write-Step 'Updating server app'
  $updateArgs = @{}
  if (![string]::IsNullOrWhiteSpace($ServerIp)) {
    $updateArgs.ServerIp = $ServerIp
  }
  if ($SkipGitPull) {
    $updateArgs.SkipGitPull = $true
  }
  if ($SkipInstall) {
    $updateArgs.SkipInstall = $true
  }
  if ($RestartFrontendTask) {
    $updateArgs.RestartFrontendTask = $true
  }
  & (Join-Path $PSScriptRoot 'update-server-app.ps1') @updateArgs

  if ($BuildElectron) {
    Write-Step 'Building Electron installer'
    $electronArgs = @{}
    if (![string]::IsNullOrWhiteSpace($ServerIp)) {
      $electronArgs.ServerIp = $ServerIp
    }
    if ($SkipInstall) {
      $electronArgs.SkipInstall = $true
    }
    $electronArgs.SkipFrontendBuild = $true
    & (Join-Path $PSScriptRoot 'build-electron-installer.ps1') @electronArgs
  }

  Write-Step 'Final health check'
  if (!(Wait-BackendHealth -Seconds 20)) {
    throw 'Backend is not reachable on port 5000 after update.'
  }

  Write-Host ''
  Write-Host 'Badizo POS update completed successfully.' -ForegroundColor Green
  Write-Host 'Backend health: OK'
  if ($BuildElectron) {
    Write-Host 'Electron installer was rebuilt. Copy the newest installer from electron\dist to slave machines and run it there.'
  }
} catch {
  Write-Host ''
  Write-Host 'Badizo POS update failed.' -ForegroundColor Red
  Write-Host $_.Exception.Message -ForegroundColor Red
  Write-Host ''
  Write-Host 'If this failed while creating the backend startup task, open PowerShell as Administrator and run this same script again.' -ForegroundColor Yellow
  exit 1
}
