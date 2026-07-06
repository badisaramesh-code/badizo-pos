param(
  [string]$ServerIp = '192.168.1.9',
  [switch]$SkipInstall,
  [switch]$SkipFrontendRestart
)

$ErrorActionPreference = 'Stop'

function Assert-Administrator {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = New-Object Security.Principal.WindowsPrincipal($identity)
  if (!$principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw 'Run this update as Administrator. Use apply-shop-update-one-click.bat for automatic UAC prompt.'
  }
}

function Write-Step {
  param([string]$Message)
  Write-Host ''
  Write-Host "== $Message ==" -ForegroundColor Cyan
}

function Test-Url {
  param([string]$Url)

  try {
    $response = Invoke-WebRequest -UseBasicParsing -Uri $Url -TimeoutSec 8
    if ($response.StatusCode -ge 200 -and $response.StatusCode -lt 400) {
      Write-Host "OK: $Url" -ForegroundColor Green
      return $true
    }
  } catch {
    Write-Host "FAILED: $Url" -ForegroundColor Red
    return $false
  }

  Write-Host "FAILED: $Url" -ForegroundColor Red
  return $false
}

try {
  Assert-Administrator

  $updateScript = Join-Path $PSScriptRoot 'update-badizo-app.ps1'
  if (!(Test-Path $updateScript)) {
    throw "Missing update script: $updateScript"
  }

  Write-Host 'Badizo POS shop update' -ForegroundColor Green
  Write-Host "Server IP: $ServerIp"
  Write-Host "Update folder: $(Split-Path -Parent (Split-Path -Parent $PSScriptRoot))"

  $updateArgs = @{
    ServerIp = $ServerIp
    SkipGitPull = $true
  }
  if ($SkipInstall) {
    $updateArgs.SkipInstall = $true
  }
  if (!$SkipFrontendRestart) {
    $updateArgs.RestartFrontendTask = $true
  }

  Write-Step 'Applying update'
  & $updateScript @updateArgs

  Write-Step 'Final server checks'
  $backendOk = Test-Url -Url "http://${ServerIp}:5000/api/health"
  $frontendOk = Test-Url -Url "http://${ServerIp}:3000"

  if (!$backendOk -or !$frontendOk) {
    throw 'Update finished, but final server checks failed. Check backend/frontend scheduled tasks and firewall.'
  }

  Write-Host ''
  Write-Host 'Shop update completed successfully.' -ForegroundColor Green
  Write-Host ''
  Write-Host 'Press Enter to close this window.'
  Read-Host | Out-Null
} catch {
  Write-Host ''
  Write-Host 'Shop update failed.' -ForegroundColor Red
  Write-Host $_.Exception.Message -ForegroundColor Red
  Write-Host ''
  Write-Host 'Press Enter to close this window.'
  Read-Host | Out-Null
  exit 1
}
