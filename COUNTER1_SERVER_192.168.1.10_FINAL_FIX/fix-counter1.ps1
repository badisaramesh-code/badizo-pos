$ErrorActionPreference = 'Stop'
$serverIp = '192.168.1.10'
$appUrl = "http://${serverIp}:5000?loginMode=counter&loginUser=counter1"
$healthUrl = "http://${serverIp}:5000/api/health"

try {
  Write-Host 'Closing old Badizo Counter1 app...' -ForegroundColor Cyan
  Get-Process -Name Badizo -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue

  Write-Host 'Writing correct Counter1 server settings...' -ForegroundColor Cyan
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
    loginUser = 'counter1'
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
  $launcher = Join-Path $launcherDir 'Badizo Counter1.cmd'
  New-Item -ItemType Directory -Force -Path $launcherDir | Out-Null
  @"
@echo off
rem Counter PCs must never start a local Badizo backend. Open in a normal browser
rem window so closing the print preview never closes the billing application.
if exist "%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe" (
  start "" "%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe" --new-window "$appUrl"
  exit /b
)
if exist "%ProgramFiles%\Google\Chrome\Application\chrome.exe" (
  start "" "%ProgramFiles%\Google\Chrome\Application\chrome.exe" --new-window "$appUrl"
  exit /b
)
start "" "$appUrl"
"@ | Set-Content -Path $launcher -Encoding ASCII

  $desktop = [Environment]::GetFolderPath('Desktop')
  $shortcutPath = Join-Path $desktop 'Badizo Counter1.lnk'
  $shell = New-Object -ComObject WScript.Shell
  $shortcut = $shell.CreateShortcut($shortcutPath)
  $shortcut.TargetPath = $launcher
  $shortcut.WorkingDirectory = $launcherDir
  $edge = Join-Path ${env:ProgramFiles(x86)} 'Microsoft\Edge\Application\msedge.exe'
  if (Test-Path $edge) { $shortcut.IconLocation = $edge }
  $shortcut.Save()

  try {
    $response = Invoke-WebRequest -UseBasicParsing -Uri $healthUrl -TimeoutSec 10
    Write-Host "Server connection OK: $($response.StatusCode)" -ForegroundColor Green
  } catch {
    Write-Host 'Settings fixed, but server is not reachable now. Check LAN cable and server 192.168.1.10.' -ForegroundColor Yellow
  }

  Write-Host 'SUCCESS: Counter1 now opens the server directly and will not start a local backend.' -ForegroundColor Green
  Start-Process -FilePath $launcher
  exit 0
} catch {
  Write-Host $_.Exception.Message -ForegroundColor Red
  exit 1
}
