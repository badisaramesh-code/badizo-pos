$ErrorActionPreference = 'Stop'
$serverHost = '192.168.1.10'
$admin1Ip = '192.168.1.7'
$printerName = 'TSC TE244'
$shareName = 'TSC-244-2'
$printerUser = 'badizo-printer'
$printerPassword = 'BadizoPrint#244'
$appUrl = "http://${serverHost}:5000?loginMode=admin&loginUser=admin1"

function Step([string]$message) {
  Write-Host ''
  Write-Host "== $message ==" -ForegroundColor Cyan
}

try {
  Step 'Checking TSC TE244 printer'
  $printer = Get-Printer -Name $printerName -ErrorAction SilentlyContinue
  if (!$printer) {
    $printer = Get-Printer -ErrorAction SilentlyContinue |
      Where-Object { $_.Name -match 'TSC.*(TE244|244)' } |
      Select-Object -First 1
  }
  if (!$printer) {
    throw 'TSC TE244 printer is not installed. Connect the printer and install its Windows driver, then run this setup again.'
  }

  Set-Printer -Name $printer.Name -Shared $true -ShareName $shareName
  Write-Host "Printer ready: $($printer.Name) -> \\$env:COMPUTERNAME\$shareName" -ForegroundColor Green

  Step 'Enabling Windows printer sharing'
  $securePassword = ConvertTo-SecureString $printerPassword -AsPlainText -Force
  $existingUser = Get-LocalUser -Name $printerUser -ErrorAction SilentlyContinue
  if ($existingUser) {
    Set-LocalUser -Name $printerUser -Password $securePassword -PasswordNeverExpires $true
  } else {
    New-LocalUser -Name $printerUser -Password $securePassword -PasswordNeverExpires -AccountNeverExpires -Description 'Badizo barcode printer network access' | Out-Null
  }
  Enable-LocalUser -Name $printerUser
  Add-LocalGroupMember -Group 'Users' -Member $printerUser -ErrorAction SilentlyContinue
  Set-Service -Name LanmanServer -StartupType Automatic
  Start-Service -Name LanmanServer
  Set-Service -Name Spooler -StartupType Automatic
  Start-Service -Name Spooler
  Get-NetFirewallRule -DisplayGroup 'File and Printer Sharing' -ErrorAction SilentlyContinue |
    Set-NetFirewallRule -Enabled True -Profile Private -ErrorAction SilentlyContinue

  Step 'Checking Admin1 network address'
  $localIps = Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
    Where-Object { $_.IPAddress -notlike '169.254.*' -and $_.IPAddress -ne '127.0.0.1' } |
    Select-Object -ExpandProperty IPAddress
  Write-Host "Expected Admin1 IP: $admin1Ip"
  Write-Host "Detected IP(s): $($localIps -join ', ')"
  if ($localIps -notcontains $admin1Ip) {
    Write-Host "WARNING: Admin1 is not using $admin1Ip. Server printer mapping must use this computer's actual fixed IP." -ForegroundColor Yellow
  }

  Step 'Installing current Badizo app'
  $installer = Get-ChildItem -LiteralPath $PSScriptRoot -Filter 'Badizo Setup*.exe' -File |
    Sort-Object LastWriteTime -Descending | Select-Object -First 1
  if (!$installer) { throw 'Badizo Setup installer is missing from this folder.' }
  Get-Process -Name Badizo -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
  $install = Start-Process -FilePath $installer.FullName -ArgumentList '/S' -Wait -PassThru
  if ($install.ExitCode -ne 0) { throw "Badizo installer failed with code $($install.ExitCode)." }

  Step 'Writing Admin1 connection and login settings'
  $config = [ordered]@{
    appUrl = $appUrl
    apiHealthUrl = "http://${serverHost}:5000/api/health"
    backendPort = 5000
    frontendPort = 5000
    startBackend = $false
    startFrontend = $false
    serverHosts = @($serverHost, 'badizo-server.local', 'badizo-server', 'server')
    discoveryEnabled = $true
    discoveryTimeoutMs = 15000
    loginMode = 'admin'
    loginUser = 'admin1'
    kiosk = $false
    devTools = $false
  }
  foreach ($folder in @('Badizo', 'badizo-desktop')) {
    $configDir = Join-Path $env:APPDATA $folder
    New-Item -ItemType Directory -Force -Path $configDir | Out-Null
    $config | ConvertTo-Json -Depth 5 | Set-Content -Path (Join-Path $configDir 'app-config.json') -Encoding UTF8
  }

  $launcherDir = Join-Path $env:APPDATA 'BadizoLaunchers'
  $launcher = Join-Path $launcherDir 'Badizo Admin1.cmd'
  New-Item -ItemType Directory -Force -Path $launcherDir | Out-Null
  @"
@echo off
set "BADIZO_APP_URL=$appUrl"
set "BADIZO_API_HEALTH_URL=http://${serverHost}:5000/api/health"
set "BADIZO_LOGIN_MODE=admin"
set "BADIZO_LOGIN_USER=admin1"
if exist "%LOCALAPPDATA%\Programs\Badizo\Badizo.exe" start "" "%LOCALAPPDATA%\Programs\Badizo\Badizo.exe" & exit /b
if exist "%ProgramFiles%\Badizo\Badizo.exe" start "" "%ProgramFiles%\Badizo\Badizo.exe" & exit /b
start "" "$appUrl"
"@ | Set-Content -Path $launcher -Encoding ASCII

  $desktop = [Environment]::GetFolderPath('Desktop')
  $shortcutPath = Join-Path $desktop 'Badizo Admin1.lnk'
  $shell = New-Object -ComObject WScript.Shell
  $shortcut = $shell.CreateShortcut($shortcutPath)
  $shortcut.TargetPath = $launcher
  $shortcut.WorkingDirectory = $launcherDir
  $appExe = Join-Path $env:LOCALAPPDATA 'Programs\Badizo\Badizo.exe'
  if (Test-Path $appExe) { $shortcut.IconLocation = $appExe }
  $shortcut.Save()

  Step 'Final checks'
  try {
    $health = Invoke-WebRequest -UseBasicParsing -Uri "http://${serverHost}:5000/api/health" -TimeoutSec 10
    Write-Host "Badizo server connection OK ($($health.StatusCode))." -ForegroundColor Green
  } catch {
    Write-Host "WARNING: Server $serverHost is not reachable now. Check LAN/server firewall." -ForegroundColor Yellow
  }
  Write-Host "33x25 printer share: \\$admin1Ip\$shareName" -ForegroundColor Green
  Write-Host 'Desktop shortcut created: Badizo Admin1' -ForegroundColor Green
  Start-Process -FilePath $launcher
  exit 0
} catch {
  Write-Host ''
  Write-Host $_.Exception.Message -ForegroundColor Red
  exit 1
}
