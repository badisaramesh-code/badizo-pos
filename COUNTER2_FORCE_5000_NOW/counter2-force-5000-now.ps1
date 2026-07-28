$ErrorActionPreference = 'Stop'

$serverHost = '192.168.1.9'
$loginUser = 'counter2'
$appUrl = "http://${serverHost}:5000?loginMode=counter&loginUser=${loginUser}"
$healthUrl = "http://${serverHost}:5000/api/health"

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

function Write-BadizoConfig {
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

function Write-Launcher {
  $appExe = Find-BadizoExe
  if ([string]::IsNullOrWhiteSpace($appExe)) {
    Write-Host 'Badizo.exe not found. Config was updated; open Badizo after installation.' -ForegroundColor Yellow
    return
  }

  $launcherDir = Join-Path $env:APPDATA 'Badizo'
  New-Item -ItemType Directory -Force -Path $launcherDir | Out-Null
  $cmdPath = Join-Path $launcherDir 'Badizo Counter2 5000 Launcher.cmd'
  $vbsPath = Join-Path $launcherDir 'Badizo Counter2 5000 Launcher.vbs'

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
  $targets = @(
    (Join-Path $desktop 'Badizo Counter2.lnk'),
    (Join-Path $desktop 'Badizo.lnk')
  )
  $publicDesktop = Join-Path $env:PUBLIC 'Desktop'
  if (Test-Path $publicDesktop) {
    $targets += (Join-Path $publicDesktop 'Badizo Counter2.lnk')
    $targets += (Join-Path $publicDesktop 'Badizo.lnk')
  }

  $shell = New-Object -ComObject WScript.Shell
  foreach ($shortcutPath in @($targets | Select-Object -Unique)) {
    try {
      $shortcut = $shell.CreateShortcut($shortcutPath)
      $shortcut.TargetPath = "$env:SystemRoot\System32\wscript.exe"
      $shortcut.Arguments = "`"$vbsPath`""
      $shortcut.WorkingDirectory = Split-Path -Parent $appExe
      if ($icon) { $shortcut.IconLocation = "$icon,0" }
      $shortcut.Description = 'Badizo Counter2 5000'
      $shortcut.Save()
      Write-Host "Shortcut updated: $shortcutPath" -ForegroundColor Green
    } catch {
      Write-Host "Could not update shortcut: $shortcutPath" -ForegroundColor Yellow
    }
  }
}

try {
  Write-Host 'Badizo Counter2 force 5000 fix' -ForegroundColor Green
  Write-Host "Counter2 URL: $appUrl" -ForegroundColor Green

  Write-Step 'Checking server 5000'
  if (!(Test-BadizoHealth)) {
    Write-Host "Server health not reachable now: $healthUrl" -ForegroundColor Yellow
    Write-Host 'Continuing config fix anyway. Check LAN/firewall if app does not open.' -ForegroundColor Yellow
  } else {
    Write-Host "Server OK: $healthUrl" -ForegroundColor Green
  }

  Write-Step 'Closing old Badizo windows'
  Get-Process -Name Badizo -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue

  Write-Step 'Writing 5000 config'
  Write-BadizoConfig

  Write-Step 'Updating desktop shortcut'
  Write-Launcher

  Write-Step 'Opening Counter2'
  $launcher = Join-Path (Join-Path $env:APPDATA 'Badizo') 'Badizo Counter2 5000 Launcher.cmd'
  if (Test-Path $launcher) {
    Start-Process -FilePath $launcher
  }

  Write-Host ''
  Write-Host 'Done. Badizo Counter2 now uses port 5000 only.' -ForegroundColor Green
  Write-Host $appUrl -ForegroundColor Green
} catch {
  Write-Host ''
  Write-Host 'Counter2 5000 fix failed.' -ForegroundColor Red
  Write-Host $_.Exception.Message -ForegroundColor Red
  exit 1
}
