param(
  [string]$ServerIp = '192.168.1.7'
)

$ErrorActionPreference = 'Stop'

function Write-Step {
  param([string]$Message)
  Write-Host ''
  Write-Host "== $Message ==" -ForegroundColor Cyan
}

function Assert-Administrator {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = New-Object Security.Principal.WindowsPrincipal($identity)
  if (!$principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw 'Run this setup as Administrator. Use setup-server-lan-one-click.bat for automatic UAC prompt.'
  }
}

function Add-FirewallRuleIfMissing {
  param(
    [string]$DisplayName,
    [int]$Port
  )

  $existing = Get-NetFirewallRule -DisplayName $DisplayName -ErrorAction SilentlyContinue
  if ($existing) {
    Write-Host "Firewall rule already exists: $DisplayName" -ForegroundColor Yellow
    return
  }

  New-NetFirewallRule `
    -DisplayName $DisplayName `
    -Direction Inbound `
    -Protocol TCP `
    -LocalPort $Port `
    -Action Allow | Out-Null

  Write-Host "Firewall rule added: $DisplayName" -ForegroundColor Green
}

function Resolve-Npm {
  $npmCmd = 'C:\Program Files\nodejs\npm.cmd'
  if (Test-Path $npmCmd) {
    return $npmCmd
  }

  $command = Get-Command npm.cmd -ErrorAction SilentlyContinue
  if (!$command) {
    throw 'npm.cmd was not found. Install Node.js first.'
  }

  return $command.Source
}

function Build-Frontend {
  param(
    [string]$AppRoot,
    [string]$ServerIp
  )

  Write-Step 'Building production frontend'
  $frontendDir = Join-Path $AppRoot 'frontend'
  $npm = Resolve-Npm
  if (!(Test-Path (Join-Path $frontendDir 'package.json'))) {
    throw "Missing frontend package.json: $frontendDir"
  }

  Push-Location $frontendDir
  $previousApiBaseUrl = $env:REACT_APP_API_BASE_URL
  $previousSkipOpenAfterBuild = $env:BADIZO_SKIP_OPEN_AFTER_BUILD
  try {
    $env:REACT_APP_API_BASE_URL = "http://$ServerIp`:5000/api"
    $env:BADIZO_SKIP_OPEN_AFTER_BUILD = '1'
    & $npm run build
    $exitCode = $LASTEXITCODE
  } finally {
    $env:REACT_APP_API_BASE_URL = $previousApiBaseUrl
    $env:BADIZO_SKIP_OPEN_AFTER_BUILD = $previousSkipOpenAfterBuild
    Pop-Location
  }

  if ($exitCode -ne 0) {
    throw 'Frontend build failed.'
  }
}

function Test-Port {
  param(
    [string]$HostName,
    [int]$Port
  )

  $result = Test-NetConnection -ComputerName $HostName -Port $Port -WarningAction SilentlyContinue
  if ($result.TcpTestSucceeded) {
    Write-Host "OK: ${HostName}:${Port}" -ForegroundColor Green
    return $true
  }

  Write-Host "FAILED: ${HostName}:${Port}" -ForegroundColor Red
  return $false
}

function Test-Http {
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
}

Assert-Administrator

$scriptRoot = $PSScriptRoot
$appRoot = Split-Path -Parent (Split-Path -Parent $scriptRoot)
$backendTaskScript = Join-Path $scriptRoot 'install-backend-startup-task.ps1'
$frontendTaskScript = Join-Path $scriptRoot 'install-frontend-startup-task.ps1'

Write-Host 'Badizo POS server LAN one-click setup' -ForegroundColor Green
Write-Host "App folder: $appRoot"
Write-Host "Server IP: $ServerIp"

Build-Frontend -AppRoot $appRoot -ServerIp $ServerIp

Write-Step 'Installing backend startup task'
& $backendTaskScript

Write-Step 'Installing frontend startup task'
& $frontendTaskScript -ServerIp $ServerIp

Write-Step 'Allowing Badizo ports through Windows Firewall'
Add-FirewallRuleIfMissing -DisplayName 'Badizo Frontend 3000' -Port 3000
Add-FirewallRuleIfMissing -DisplayName 'Badizo Backend 5000' -Port 5000

Write-Step 'Starting scheduled tasks'
Start-ScheduledTask -TaskName 'Badizo POS Backend' -ErrorAction SilentlyContinue
Start-ScheduledTask -TaskName 'Badizo POS Frontend' -ErrorAction SilentlyContinue
Start-Sleep -Seconds 8

Write-Step 'Testing server ports'
$backendLocal = Test-Port -HostName 'localhost' -Port 5000
$frontendLocal = Test-Port -HostName 'localhost' -Port 3000
$backendLan = Test-Port -HostName $ServerIp -Port 5000
$frontendLan = Test-Port -HostName $ServerIp -Port 3000

Write-Step 'Testing browser URLs'
$backendHealth = Test-Http -Url "http://${ServerIp}:5000/api/health"
$frontendHome = Test-Http -Url "http://${ServerIp}:3000"

Write-Host ''
if ($backendLocal -and $frontendLocal -and $backendLan -and $frontendLan -and $backendHealth -and $frontendHome) {
  Write-Host 'Server LAN setup completed successfully. Slave PCs can use:' -ForegroundColor Green
  Write-Host "http://${ServerIp}:3000" -ForegroundColor Green
} else {
  Write-Host 'Setup finished, but one or more checks failed.' -ForegroundColor Yellow
  Write-Host 'Check that MySQL is running, Node.js is installed, and the server IP is correct.' -ForegroundColor Yellow
  Write-Host 'If localhost works but LAN IP fails, check Windows network profile/firewall.' -ForegroundColor Yellow
}

Write-Host ''
Write-Host 'Press Enter to close this window.'
Read-Host | Out-Null
