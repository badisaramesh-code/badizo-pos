param(
  [Parameter(Mandatory = $true)]
  [string]$ServerIp,
  [string]$InstallerPath = '',
  [switch]$Kiosk,
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
  Write-Step 'Checking server connection'
  $frontendPortTest = Test-NetConnection -ComputerName $ServerIp -Port 3000 -WarningAction SilentlyContinue
  if (!$frontendPortTest.TcpTestSucceeded) {
    throw "Cannot reach Badizo frontend at ${ServerIp}:3000. Check server frontend, server firewall, and same Wi-Fi/LAN."
  }

  $portTest = Test-NetConnection -ComputerName $ServerIp -Port 5000 -WarningAction SilentlyContinue
  if (!$portTest.TcpTestSucceeded) {
    throw "Cannot reach Badizo server at ${ServerIp}:5000. Check server backend, server firewall, and same Wi-Fi/LAN."
  }

  $frontendUrl = "http://${ServerIp}:3000"
  $frontendResponse = Invoke-WebRequest -UseBasicParsing -Uri $frontendUrl -TimeoutSec 5
  if ($frontendResponse.StatusCode -lt 200 -or $frontendResponse.StatusCode -ge 400) {
    throw "Server frontend check failed: $frontendUrl"
  }

  $healthUrl = "http://${ServerIp}:5000/api/health"
  $response = Invoke-WebRequest -UseBasicParsing -Uri $healthUrl -TimeoutSec 5
  if ($response.StatusCode -ne 200) {
    throw "Server health check failed: $healthUrl"
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

  $configDir = Join-Path $roamingAppData 'Badizo'
  $configPath = Join-Path $configDir 'app-config.json'
  New-Item -ItemType Directory -Force -Path $configDir | Out-Null

  $config = [ordered]@{
    appUrl = "http://${ServerIp}:3000"
    apiHealthUrl = "http://${ServerIp}:5000/api/health"
    backendPort = 5000
    frontendPort = 3000
    startBackend = $false
    startFrontend = $false
    kiosk = [bool]$Kiosk
    devTools = $false
  }

  $config | ConvertTo-Json -Depth 4 | Set-Content -Path $configPath -Encoding UTF8
  Write-Host "Config written: $configPath" -ForegroundColor Green
}

function Install-App {
  if ($SkipInstall) {
    Write-Host 'Skipping installer because -SkipInstall was used.' -ForegroundColor Yellow
    return
  }

  Write-Step 'Installing Badizo app'
  $installer = Find-Installer
  Write-Host "Installer: $installer"
  $process = Start-Process -FilePath $installer -ArgumentList '/S' -Wait -PassThru
  if ($process.ExitCode -ne 0) {
    throw "Installer failed with exit code $($process.ExitCode)."
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
