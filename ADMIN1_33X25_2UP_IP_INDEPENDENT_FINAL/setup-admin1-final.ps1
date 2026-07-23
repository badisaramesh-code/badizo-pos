$ErrorActionPreference = 'Stop'
$printerName = 'TSC TE244'
$shareName = 'TSC-244-2'
$serverNames = @('badizo-server.local', 'badizo-server', 'BADIZO-SERVER', 'server', 'SERVER')

function Step([string]$Message) {
  Write-Host ''
  Write-Host "== $Message ==" -ForegroundColor Cyan
}

try {
  Step 'Verifying the local TSC TE244 printer'
  $printer = Get-Printer -Name $printerName -ErrorAction SilentlyContinue
  if (!$printer) {
    $printer = Get-Printer -ErrorAction SilentlyContinue |
      Where-Object { $_.Name -match 'TSC.*(TE244|244)' } |
      Select-Object -First 1
  }
  if (!$printer) {
    throw 'TSC TE244 is not installed. Connect the USB printer and install the TSC Windows driver, then run this setup again.'
  }

  Set-Service -Name Spooler -StartupType Automatic
  Start-Service -Name Spooler
  Set-Service -Name LanmanServer -StartupType Automatic
  Start-Service -Name LanmanServer
  Set-Printer -Name $printer.Name -Shared $true -ShareName $shareName
  Write-Host "Printer: $($printer.Name)" -ForegroundColor Green
  Write-Host "Driver: $($printer.DriverName)"
  Write-Host "Port: $($printer.PortName)"
  Write-Host "IP-independent local path: \\localhost\$shareName" -ForegroundColor Green

  Step 'Installing the Badizo Admin1 desktop app'
  $installer = Get-ChildItem -LiteralPath $PSScriptRoot -Filter 'Badizo Setup*.exe' -File |
    Sort-Object LastWriteTime -Descending |
    Select-Object -First 1
  if (!$installer) { throw 'Badizo Setup installer is missing from this folder.' }
  Get-Process -Name Badizo -ErrorAction SilentlyContinue |
    Stop-Process -Force -ErrorAction SilentlyContinue
  $install = Start-Process -FilePath $installer.FullName -ArgumentList '/S' -Wait -PassThru
  if ($install.ExitCode -ne 0) { throw "Badizo installer failed with code $($install.ExitCode)." }

  Step 'Writing Admin1 hostname and LAN discovery settings'
  $appUrl = 'http://badizo-server:5000?loginMode=admin&loginUser=admin1'
  $config = [ordered]@{
    appUrl = $appUrl
    apiHealthUrl = 'http://badizo-server:5000/api/health'
    backendPort = 5000
    frontendPort = 5000
    startBackend = $false
    startFrontend = $false
    serverHosts = $serverNames
    discoveryEnabled = $true
    discoveryTimeoutMs = 20000
    loginMode = 'admin'
    loginUser = 'admin1'
    kiosk = $false
    devTools = $false
  }
  foreach ($folder in @('Badizo', 'badizo-desktop')) {
    $configDir = Join-Path $env:APPDATA $folder
    New-Item -ItemType Directory -Force -Path $configDir | Out-Null
    $config | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $configDir 'app-config.json') -Encoding UTF8
    foreach ($cacheName in @('Cache', 'Code Cache', 'GPUCache')) {
      $cachePath = Join-Path $configDir $cacheName
      if (Test-Path -LiteralPath $cachePath) {
        Remove-Item -LiteralPath $cachePath -Recurse -Force -ErrorAction SilentlyContinue
      }
    }
  }

  $launcherDir = Join-Path $env:APPDATA 'BadizoLaunchers'
  $launcher = Join-Path $launcherDir 'Badizo Admin1 IP Independent.cmd'
  New-Item -ItemType Directory -Force -Path $launcherDir | Out-Null
  @'
@echo off
set "BADIZO_APP_URL=http://badizo-server:5000?loginMode=admin&loginUser=admin1"
set "BADIZO_API_HEALTH_URL=http://badizo-server:5000/api/health"
set "BADIZO_SERVER_HOSTS=badizo-server.local,badizo-server,BADIZO-SERVER,server,SERVER"
set "BADIZO_LOGIN_MODE=admin"
set "BADIZO_LOGIN_USER=admin1"
if exist "%LOCALAPPDATA%\Programs\Badizo\Badizo.exe" start "" "%LOCALAPPDATA%\Programs\Badizo\Badizo.exe" & exit /b
if exist "%ProgramFiles%\Badizo\Badizo.exe" start "" "%ProgramFiles%\Badizo\Badizo.exe" & exit /b
echo Badizo.exe was not found. Run INSTALL_ADMIN1_FINAL.bat again.
pause
'@ | Set-Content -LiteralPath $launcher -Encoding ASCII

  $desktop = [Environment]::GetFolderPath('Desktop')
  $shortcutPath = Join-Path $desktop 'Badizo Admin1.lnk'
  $shell = New-Object -ComObject WScript.Shell
  $shortcut = $shell.CreateShortcut($shortcutPath)
  $shortcut.TargetPath = $launcher
  $shortcut.WorkingDirectory = $launcherDir
  $appExe = Join-Path $env:LOCALAPPDATA 'Programs\Badizo\Badizo.exe'
  if (Test-Path -LiteralPath $appExe) { $shortcut.IconLocation = $appExe }
  $shortcut.Save()

  Step 'Final verification'
  $verified = Get-Printer -Name $printer.Name
  if (!$verified.Shared -or $verified.ShareName -ne $shareName) {
    throw "Printer sharing verification failed. Expected share name: $shareName"
  }
  if ((Get-Service Spooler).Status -ne 'Running') { throw 'Windows Print Spooler is not running.' }
  Write-Host 'SUCCESS: Admin1 is ready.' -ForegroundColor Green
  Write-Host 'Sticker: 33 x 25 mm, 2-up (68 x 25 mm row, 2 mm gap)'
  Write-Host "Printer: \\localhost\$shareName"
  Write-Host 'Admin1 IP changes do not affect sticker printing.' -ForegroundColor Green
  Write-Host 'Server IP changes are handled by hostname lookup and automatic LAN scan.' -ForegroundColor Green
  Write-Host 'Open only the desktop shortcut: Badizo Admin1'
  Start-Process -FilePath $launcher
  exit 0
} catch {
  Write-Host ''
  Write-Host "FAILED: $($_.Exception.Message)" -ForegroundColor Red
  exit 1
}
