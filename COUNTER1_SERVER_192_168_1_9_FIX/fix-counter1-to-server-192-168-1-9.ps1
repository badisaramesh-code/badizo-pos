$ErrorActionPreference = 'Stop'

$serverIp = '192.168.1.9'
$loginMode = 'counter'
$loginUser = 'counter1'
$appUrl = "http://${serverIp}:5000?loginMode=${loginMode}&loginUser=${loginUser}"
$healthUrl = "http://${serverIp}:5000/api/health"

function Write-Step {
  param([string]$Message)
  Write-Host ''
  Write-Host "== $Message ==" -ForegroundColor Cyan
}

function Test-BadizoUrl {
  param([string]$Url, [int]$TimeoutSec = 5)
  try {
    $response = Invoke-WebRequest -UseBasicParsing -Uri $Url -TimeoutSec $TimeoutSec
    return ($response.StatusCode -ge 200 -and $response.StatusCode -lt 400)
  } catch {
    return $false
  }
}

try {
  Write-Step 'Checking Badizo server'
  if (!(Test-BadizoUrl -Url $healthUrl -TimeoutSec 6)) {
    throw "Cannot reach Badizo server at ${healthUrl}. Check LAN cable/Wi-Fi and make sure the server computer is ON."
  }
  Write-Host "Server OK: $healthUrl" -ForegroundColor Green

  Write-Step 'Closing old Badizo windows'
  Get-Process -Name Badizo,electron,node -ErrorAction SilentlyContinue |
    Stop-Process -Force -ErrorAction SilentlyContinue

  Write-Step 'Freeing old local port 3000 if it is stuck'
  $portOwners = @(Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue |
    Select-Object -ExpandProperty OwningProcess -Unique)
  foreach ($pid in $portOwners) {
    if ($pid -and $pid -ne $PID) {
      Stop-Process -Id $pid -Force -ErrorAction SilentlyContinue
      Write-Host "Stopped process using port 3000: $pid" -ForegroundColor Yellow
    }
  }

  Write-Step 'Writing Badizo app config everywhere'
  $roamingAppData = $env:APPDATA
  if ([string]::IsNullOrWhiteSpace($roamingAppData)) {
    $roamingAppData = Join-Path $env:USERPROFILE 'AppData\Roaming'
  }

  $config = [ordered]@{
    appUrl = $appUrl
    apiHealthUrl = $healthUrl
    serverHosts = @($serverIp, 'badizo-server.local', 'badizo-server', 'server')
    discoveryEnabled = $true
    discoveryTimeoutMs = 12000
    backendPort = 5000
    frontendPort = 3000
    startBackend = $false
    startFrontend = $false
    loginMode = $loginMode
    loginUser = $loginUser
    kiosk = $false
    devTools = $false
  }

  [Environment]::SetEnvironmentVariable('BADIZO_APP_URL', $appUrl, 'User')
  [Environment]::SetEnvironmentVariable('BADIZO_API_HEALTH_URL', $healthUrl, 'User')
  [Environment]::SetEnvironmentVariable('BADIZO_SERVER_HOSTS', $serverIp, 'User')
  [Environment]::SetEnvironmentVariable('BADIZO_FRONTEND_PORT', '5000', 'User')
  $env:BADIZO_APP_URL = $appUrl
  $env:BADIZO_API_HEALTH_URL = $healthUrl
  $env:BADIZO_SERVER_HOSTS = $serverIp
  $env:BADIZO_FRONTEND_PORT = '5000'

  $configDirs = @(
    (Join-Path $roamingAppData 'Badizo'),
    (Join-Path $roamingAppData 'badizo-desktop'),
    (Join-Path $env:LOCALAPPDATA 'Programs\Badizo'),
    (Join-Path $env:LOCALAPPDATA 'Programs\Badizo\resources'),
    (Join-Path $env:ProgramFiles 'Badizo'),
    (Join-Path $env:ProgramFiles 'Badizo\resources'),
    (Join-Path ${env:ProgramFiles(x86)} 'Badizo'),
    (Join-Path ${env:ProgramFiles(x86)} 'Badizo\resources')
  ) | Where-Object { $_ } | Select-Object -Unique

  foreach ($configDir in $configDirs) {
    New-Item -ItemType Directory -Force -Path $configDir | Out-Null
    $config | ConvertTo-Json -Depth 4 | Set-Content -Path (Join-Path $configDir 'app-config.json') -Encoding UTF8
    Write-Host "Config written: $configDir\app-config.json" -ForegroundColor Green
  }

  Write-Step 'Creating desktop browser shortcut'
  $desktop = [Environment]::GetFolderPath('Desktop')
  if ([string]::IsNullOrWhiteSpace($desktop)) {
    $desktop = Join-Path $env:USERPROFILE 'Desktop'
  }
  $shortcutPath = Join-Path $desktop 'Badizo Counter1.url'
  @(
    '[InternetShortcut]'
    "URL=$appUrl"
    'IconFile=%SystemRoot%\System32\SHELL32.dll'
    'IconIndex=220'
  ) | Set-Content -Path $shortcutPath -Encoding ASCII
  Write-Host "Shortcut written: $shortcutPath" -ForegroundColor Green

  Write-Step 'Creating forced 5000 launcher'
  $possibleExePaths = @(
    (Join-Path $env:LOCALAPPDATA 'Programs\Badizo\Badizo.exe'),
    (Join-Path $env:ProgramFiles 'Badizo\Badizo.exe'),
    (Join-Path ${env:ProgramFiles(x86)} 'Badizo\Badizo.exe')
  ) | Where-Object { $_ -and (Test-Path $_) }

  $appExe = $possibleExePaths | Select-Object -First 1
  $launcherPath = Join-Path $desktop 'Badizo Counter1 5000.cmd'
  if ($appExe) {
    @(
      '@echo off'
      'setlocal'
      'set "BADIZO_APP_URL=http://192.168.1.9:5000?loginMode=counter&loginUser=counter1"'
      'set "BADIZO_API_HEALTH_URL=http://192.168.1.9:5000/api/health"'
      'set "BADIZO_SERVER_HOSTS=192.168.1.9"'
      'set "BADIZO_FRONTEND_PORT=5000"'
      'set "BADIZO_BACKEND_PORT=5000"'
      'set "BADIZO_LOGIN_MODE=counter"'
      'set "BADIZO_LOGIN_USER=counter1"'
      "start `"Badizo Counter1`" `"$appExe`""
      'endlocal'
    ) | Set-Content -Path $launcherPath -Encoding ASCII
  } else {
    @(
      '@echo off'
      'start "" "http://192.168.1.9:5000?loginMode=counter&loginUser=counter1"'
    ) | Set-Content -Path $launcherPath -Encoding ASCII
  }
  Write-Host "Launcher written: $launcherPath" -ForegroundColor Green

  $lnkPath = Join-Path $desktop 'Badizo Counter1.lnk'
  $shell = New-Object -ComObject WScript.Shell
  $shortcut = $shell.CreateShortcut($lnkPath)
  $shortcut.TargetPath = $launcherPath
  $shortcut.WorkingDirectory = $desktop
  $shortcut.IconLocation = "$env:SystemRoot\System32\SHELL32.dll,220"
  $shortcut.Save()
  Write-Host "Desktop shortcut written: $lnkPath" -ForegroundColor Green

  Write-Step 'Launching Counter1 on 5000'
  if ($appExe) {
    Start-Process -FilePath $launcherPath
    Write-Host "Started: $appExe" -ForegroundColor Green
  } else {
    Start-Process $appUrl
    Write-Host 'Badizo.exe was not found. Opened browser shortcut instead.' -ForegroundColor Yellow
  }

  Write-Host ''
  Write-Host 'Counter1 fix completed successfully.' -ForegroundColor Green
  Write-Host "Counter1 URL: $appUrl" -ForegroundColor Green
} catch {
  Write-Host ''
  Write-Host 'Counter1 fix failed.' -ForegroundColor Red
  Write-Host $_.Exception.Message -ForegroundColor Red
  exit 1
}
