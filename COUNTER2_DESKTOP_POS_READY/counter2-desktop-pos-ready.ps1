$ErrorActionPreference = 'Stop'

$serverHost = '192.168.1.9'
$loginUser = 'counter2'
$appUrl = "http://${serverHost}:5000?loginMode=counter&loginUser=${loginUser}"
$healthUrl = "http://${serverHost}:5000/api/health"
$installerPath = Join-Path $PSScriptRoot 'Badizo Setup 1.0.0.exe'

function Write-Step {
  param([string]$Message)
  Write-Host ''
  Write-Host "== $Message ==" -ForegroundColor Cyan
}

function Test-BadizoHealth {
  try {
    $response = Invoke-WebRequest -UseBasicParsing -Uri $healthUrl -TimeoutSec 5
    return ($response.StatusCode -ge 200 -and $response.StatusCode -lt 400)
  } catch {
    return $false
  }
}

function Find-BadizoExe {
  $paths = @(
    (Join-Path $env:LOCALAPPDATA 'Programs\Badizo\Badizo.exe'),
    (Join-Path $env:ProgramFiles 'Badizo\Badizo.exe'),
    (Join-Path ${env:ProgramFiles(x86)} 'Badizo\Badizo.exe')
  )
  return ($paths | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1)
}

function Find-BadizoIcon {
  param([string]$AppExe)
  if ([string]::IsNullOrWhiteSpace($AppExe)) { return '' }
  $appDir = Split-Path -Parent $AppExe
  $paths = @(
    (Join-Path $appDir 'resources\assets\badizo.ico'),
    (Join-Path $appDir 'assets\badizo.ico'),
    $AppExe
  )
  return ($paths | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1)
}

function Install-LatestBadizo {
  if (!(Test-Path $installerPath)) {
    throw "Installer not found: $installerPath"
  }

  Write-Step 'Installing latest 5000-only Badizo desktop app'
  Get-Process -Name Badizo -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue

  $process = Start-Process -FilePath $installerPath -ArgumentList '/S' -Wait -PassThru
  if ($process.ExitCode -ne 0) {
    Write-Host "Silent installer returned $($process.ExitCode). Opening normal installer..." -ForegroundColor Yellow
    $manual = Start-Process -FilePath $installerPath -Wait -PassThru
    if ($manual.ExitCode -ne 0) {
      throw "Installer failed with exit code $($manual.ExitCode)."
    }
  }
}

function Write-BadizoConfig {
  Write-Step 'Writing Counter2 5000 config'
  $config = [ordered]@{
    appUrl = $appUrl
    apiHealthUrl = $healthUrl
    serverHosts = @($serverHost, 'badizo-server.local', 'badizo-server', 'server')
    discoveryEnabled = $true
    discoveryTimeoutMs = 12000
    backendPort = 5000
    frontendPort = 5000
    startBackend = $false
    startFrontend = $false
    loginMode = 'counter'
    loginUser = $loginUser
    kiosk = $false
    devTools = $false
  }

  foreach ($name in @('Badizo', 'badizo-desktop')) {
    $configDir = Join-Path $env:APPDATA $name
    New-Item -ItemType Directory -Force -Path $configDir | Out-Null
    $configPath = Join-Path $configDir 'app-config.json'
    $config | ConvertTo-Json -Depth 4 | Set-Content -Path $configPath -Encoding UTF8
    Write-Host "Config updated: $configPath" -ForegroundColor Green
  }
}

function Write-DesktopLauncher {
  Write-Step 'Creating clean Counter2 desktop shortcut'
  $appExe = Find-BadizoExe
  if ([string]::IsNullOrWhiteSpace($appExe)) {
    throw 'Badizo.exe was not found after install.'
  }

  $launcherDir = Join-Path $env:APPDATA 'Badizo'
  New-Item -ItemType Directory -Force -Path $launcherDir | Out-Null
  $cmdPath = Join-Path $launcherDir 'Badizo Counter2 Desktop POS.cmd'
  $vbsPath = Join-Path $launcherDir 'Badizo Counter2 Desktop POS.vbs'

  @"
@echo off
set "BADIZO_APP_URL=$appUrl"
set "BADIZO_API_HEALTH_URL=$healthUrl"
set "BADIZO_SERVER_HOSTS=$serverHost,badizo-server.local,badizo-server,server"
set "BADIZO_BACKEND_PORT=5000"
set "BADIZO_FRONTEND_PORT=5000"
start "" "$appExe"
"@ | Set-Content -Path $cmdPath -Encoding ASCII

  @"
Set shell = CreateObject("WScript.Shell")
shell.Run """" & "$cmdPath" & """", 0, False
"@ | Set-Content -Path $vbsPath -Encoding ASCII

  $desktop = [Environment]::GetFolderPath('Desktop')
  if ([string]::IsNullOrWhiteSpace($desktop)) {
    $desktop = Join-Path $env:USERPROFILE 'Desktop'
  }

  $icon = Find-BadizoIcon -AppExe $appExe
  $shortcutTargets = @(
    (Join-Path $desktop 'Badizo Counter2 Desktop POS.lnk'),
    (Join-Path $desktop 'Badizo Counter2.lnk')
  )
  $publicDesktop = Join-Path $env:PUBLIC 'Desktop'
  if (Test-Path $publicDesktop) {
    $shortcutTargets += (Join-Path $publicDesktop 'Badizo Counter2 Desktop POS.lnk')
    $shortcutTargets += (Join-Path $publicDesktop 'Badizo Counter2.lnk')
  }

  $shell = New-Object -ComObject WScript.Shell
  foreach ($shortcutPath in @($shortcutTargets | Select-Object -Unique)) {
    try {
      $shortcut = $shell.CreateShortcut($shortcutPath)
      $shortcut.TargetPath = "$env:SystemRoot\System32\wscript.exe"
      $shortcut.Arguments = "`"$vbsPath`""
      $shortcut.WorkingDirectory = Split-Path -Parent $appExe
      if ($icon) { $shortcut.IconLocation = "$icon,0" }
      $shortcut.Description = 'Badizo Counter2 Desktop POS - 5000 direct thermal'
      $shortcut.Save()
      Write-Host "Shortcut updated: $shortcutPath" -ForegroundColor Green
    } catch {
      Write-Host "Could not update shortcut: $shortcutPath" -ForegroundColor Yellow
    }
  }
}

try {
  Write-Host 'Badizo Counter2 Desktop POS Ready' -ForegroundColor Green
  Write-Host "Counter2 URL: $appUrl" -ForegroundColor Green

  Write-Step 'Checking server LAN 5000'
  if (Test-BadizoHealth) {
    Write-Host "Server OK: $healthUrl" -ForegroundColor Green
  } else {
    Write-Host "Server not reachable now: $healthUrl" -ForegroundColor Yellow
    Write-Host 'Setup will continue. If the app does not open, check LAN/server/firewall.' -ForegroundColor Yellow
  }

  Install-LatestBadizo
  Write-BadizoConfig
  Write-DesktopLauncher

  Write-Step 'Opening Counter2 desktop POS'
  $launcher = Join-Path (Join-Path $env:APPDATA 'Badizo') 'Badizo Counter2 Desktop POS.cmd'
  Start-Process -FilePath $launcher

  Write-Host ''
  Write-Host 'Done. Use desktop shortcut: Badizo Counter2 Desktop POS' -ForegroundColor Green
  Write-Host 'This shortcut uses 5000 and desktop direct thermal print.' -ForegroundColor Green
} catch {
  Write-Host ''
  Write-Host 'Counter2 desktop POS setup failed.' -ForegroundColor Red
  Write-Host $_.Exception.Message -ForegroundColor Red
  exit 1
}
