$ErrorActionPreference = 'Stop'
$serverIp = '192.168.1.10'
$appUrl = "http://${serverIp}:5000?loginMode=counter&loginUser=counter2"
$healthUrl = "http://${serverIp}:5000/api/health"

try {
  Write-Host 'Closing old Badizo Counter2 app...' -ForegroundColor Cyan
  Get-Process -Name Badizo -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue

  Write-Host 'Writing correct Counter2 server settings...' -ForegroundColor Cyan
  $config = [ordered]@{
    appUrl = $appUrl
    apiHealthUrl = $healthUrl
    backendPort = 5000
    frontendPort = 5000
    startBackend = $false
    startFrontend = $false
    serverHosts = @($serverIp, 'badizo-server.local', 'badizo-server', 'server')
    discoveryEnabled = $true
    discoveryTimeoutMs = 15000
    loginMode = 'counter'
    loginUser = 'counter2'
    forcePackagedConfig = $false
    kiosk = $false
    devTools = $false
  }

  foreach ($name in @('Badizo', 'badizo-desktop')) {
    $dir = Join-Path $env:APPDATA $name
    New-Item -ItemType Directory -Force -Path $dir | Out-Null
    $config | ConvertTo-Json -Depth 5 | Set-Content -Path (Join-Path $dir 'app-config.json') -Encoding UTF8
  }

  $launcherDir = Join-Path $env:APPDATA 'BadizoLaunchers'
  $launcher = Join-Path $launcherDir 'Badizo Counter2.cmd'
  New-Item -ItemType Directory -Force -Path $launcherDir | Out-Null
  @"
@echo off
set "BADIZO_APP_URL=$appUrl"
set "BADIZO_API_HEALTH_URL=$healthUrl"
set "BADIZO_LOGIN_MODE=counter"
set "BADIZO_LOGIN_USER=counter2"
if exist "%LOCALAPPDATA%\Programs\Badizo\Badizo.exe" start "" "%LOCALAPPDATA%\Programs\Badizo\Badizo.exe" & exit /b
if exist "%ProgramFiles%\Badizo\Badizo.exe" start "" "%ProgramFiles%\Badizo\Badizo.exe" & exit /b
start "" "$appUrl"
"@ | Set-Content -Path $launcher -Encoding ASCII

  $desktop = [Environment]::GetFolderPath('Desktop')
  $shortcutPath = Join-Path $desktop 'Badizo Counter2.lnk'
  $shell = New-Object -ComObject WScript.Shell
  $shortcut = $shell.CreateShortcut($shortcutPath)
  $shortcut.TargetPath = $launcher
  $shortcut.WorkingDirectory = $launcherDir
  $exe = Join-Path $env:LOCALAPPDATA 'Programs\Badizo\Badizo.exe'
  if (Test-Path $exe) { $shortcut.IconLocation = $exe }
  $shortcut.Save()

  try {
    $response = Invoke-WebRequest -UseBasicParsing -Uri $healthUrl -TimeoutSec 10
    Write-Host "Server connection OK: $($response.StatusCode)" -ForegroundColor Green
  } catch {
    Write-Host 'Settings fixed, but server is not reachable now. Check LAN cable and server 192.168.1.10.' -ForegroundColor Yellow
  }

  Write-Host 'SUCCESS: Counter2 now uses server 192.168.1.10.' -ForegroundColor Green
  Start-Process -FilePath $launcher
  exit 0
} catch {
  Write-Host $_.Exception.Message -ForegroundColor Red
  exit 1
}
