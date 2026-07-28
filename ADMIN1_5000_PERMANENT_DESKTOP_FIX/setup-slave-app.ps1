param(
  [Parameter(Mandatory = $true)]
  [string]$ServerIp,
  [ValidateSet('counter', 'admin', 'server', 'all')]
  [string]$LoginMode = 'counter',
  [string]$LoginUser = '',
  [string]$InstallerPath = '',
  [switch]$Kiosk,
  [switch]$SkipServerCheck,
  [switch]$SkipInstall,
  [switch]$SkipLaunch
)

$ErrorActionPreference = 'Stop'

function Write-Step {
  param([string]$Message)
  Write-Host ''
  Write-Host "== $Message ==" -ForegroundColor Cyan
}

function Find-Installer {
  if (![string]::IsNullOrWhiteSpace($InstallerPath)) {
    if (!(Test-Path $InstallerPath)) {
      throw "Installer not found: $InstallerPath"
    }
    return (Resolve-Path $InstallerPath).Path
  }

  $scriptFolder = $PSScriptRoot
  $candidates = @(
    (Get-ChildItem -Path $scriptFolder -Filter 'Badizo Setup*.exe' -File -ErrorAction SilentlyContinue),
    (Get-ChildItem -Path (Get-Location) -Filter 'Badizo Setup*.exe' -File -ErrorAction SilentlyContinue),
    (Get-ChildItem -Path (Join-Path $scriptFolder '..\..\electron\dist') -Filter 'Badizo Setup*.exe' -File -ErrorAction SilentlyContinue)
  ) | ForEach-Object { $_ }

  $installer = $candidates | Sort-Object LastWriteTime -Descending | Select-Object -First 1
  if (!$installer) {
    throw 'Badizo installer was not found. Keep this script in the same folder as "Badizo Setup 1.0.0.exe", or pass -InstallerPath "C:\path\Badizo Setup 1.0.0.exe".'
  }

  return $installer.FullName
}

function Test-Server {
  if ($SkipServerCheck) {
    Write-Host 'Skipping server pre-check because -SkipServerCheck was used.' -ForegroundColor Yellow
    return
  }

  Write-Step 'Checking server connection'
  $frontendUrl = "http://${ServerIp}:3000"
  try {
    $frontendResponse = Invoke-WebRequest -UseBasicParsing -Uri $frontendUrl -TimeoutSec 15
    if ($frontendResponse.StatusCode -lt 200 -or $frontendResponse.StatusCode -ge 400) {
      throw "Server frontend check failed: $frontendUrl"
    }
  } catch {
    throw "Cannot reach Badizo frontend at ${frontendUrl}. Open this URL in browser on Counter2. If it does not open, check same LAN/firewall/server."
  }

  $healthUrl = "http://${ServerIp}:5000/api/health"
  try {
    $response = Invoke-WebRequest -UseBasicParsing -Uri $healthUrl -TimeoutSec 15
    if ($response.StatusCode -ne 200) {
      throw "Server health check failed: $healthUrl"
    }
  } catch {
    throw "Cannot reach Badizo backend at ${healthUrl}. Check backend server, firewall, and same LAN."
  }

  Write-Host "Frontend OK: $frontendUrl" -ForegroundColor Green
  Write-Host "Server OK: $healthUrl" -ForegroundColor Green
}

function Write-AppConfig {
  Write-Step 'Writing slave app config'
  $roamingAppData = $env:APPDATA
  if ([string]::IsNullOrWhiteSpace($roamingAppData)) {
    $roamingAppData = Join-Path $env:USERPROFILE 'AppData\Roaming'
  }
  if ([string]::IsNullOrWhiteSpace($roamingAppData)) {
    throw 'APPDATA path was not found for this Windows user.'
  }

  $appUrl = "http://${ServerIp}:3000"
  $queryParts = @()
  if (![string]::IsNullOrWhiteSpace($LoginMode)) {
    $queryParts += "loginMode=$([uri]::EscapeDataString($LoginMode.Trim().ToLower()))"
  }
  if (![string]::IsNullOrWhiteSpace($LoginUser)) {
    $queryParts += "loginUser=$([uri]::EscapeDataString($LoginUser.Trim().ToLower()))"
  }
  if ($queryParts.Count -gt 0) {
    $appUrl = "$appUrl`?$($queryParts -join '&')"
  }

  $config = [ordered]@{
    appUrl = $appUrl
    apiHealthUrl = "http://${ServerIp}:5000/api/health"
    backendPort = 5000
    frontendPort = 3000
    startBackend = $false
    startFrontend = $false
    loginMode = $LoginMode
    kiosk = [bool]$Kiosk
    devTools = $false
  }

  $configJson = $config | ConvertTo-Json -Depth 4
  $configDirs = @(
    (Join-Path $roamingAppData 'Badizo'),
    (Join-Path $roamingAppData 'badizo-desktop')
  ) | Select-Object -Unique

  foreach ($configDir in $configDirs) {
    $configPath = Join-Path $configDir 'app-config.json'
    New-Item -ItemType Directory -Force -Path $configDir | Out-Null
    $configJson | Set-Content -Path $configPath -Encoding UTF8
    Write-Host "Config written: $configPath" -ForegroundColor Green
  }
}

function Install-App {
  if ($SkipInstall) {
    Write-Host 'Skipping installer because -SkipInstall was used.' -ForegroundColor Yellow
    return
  }

  Write-Step 'Installing Badizo app'
  $installer = Find-Installer
  Write-Host "Installer: $installer"

  Get-Process -Name Badizo -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue

  $process = Start-Process -FilePath $installer -ArgumentList '/S' -Wait -PassThru
  if ($process.ExitCode -ne 0) {
    Write-Host "Silent installer returned exit code $($process.ExitCode)." -ForegroundColor Yellow
    Write-Host 'Opening normal installer. Complete the installer window, then this setup will continue.' -ForegroundColor Yellow

    $manualProcess = Start-Process -FilePath $installer -Wait -PassThru
    if ($manualProcess.ExitCode -ne 0) {
      throw "Installer failed with exit code $($manualProcess.ExitCode). Close Badizo if it is open, then run this setup again."
    }
  }
  Write-Host 'Install completed.' -ForegroundColor Green
}

function Launch-App {
  if ($SkipLaunch) {
    Write-Host 'Skipping app launch because -SkipLaunch was used.' -ForegroundColor Yellow
    return
  }

  Write-Step 'Launching Badizo'
  $possibleExePaths = @(
    (Join-Path $env:LOCALAPPDATA 'Programs\Badizo\Badizo.exe'),
    (Join-Path $env:ProgramFiles 'Badizo\Badizo.exe'),
    (Join-Path ${env:ProgramFiles(x86)} 'Badizo\Badizo.exe')
  ) | Where-Object { $_ -and (Test-Path $_) }

  $appExe = $possibleExePaths | Select-Object -First 1
  if (!$appExe) {
    Write-Host 'Badizo.exe was not found in the default install folders. Open Badizo from the desktop shortcut.' -ForegroundColor Yellow
    return
  }

  Start-Process -FilePath $appExe
  Write-Host "Started: $appExe" -ForegroundColor Green
}

try {
  Write-Host 'Badizo POS slave setup' -ForegroundColor Green
  Write-Host "Server IP: $ServerIp"
  Write-Host "Login mode: $LoginMode"
  if (![string]::IsNullOrWhiteSpace($LoginUser)) {
    Write-Host "Login user: $LoginUser"
  }
  Test-Server
  Write-AppConfig
  Install-App
  Launch-App

  Write-Host ''
  Write-Host 'Slave setup completed successfully.' -ForegroundColor Green
} catch {
  Write-Host ''
  Write-Host 'Slave setup failed.' -ForegroundColor Red
  Write-Host $_.Exception.Message -ForegroundColor Red
  exit 1
}
