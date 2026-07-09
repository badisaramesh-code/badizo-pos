param(
  [string]$InstallerPath = '',
  [ValidatePattern('^counter[1-6]$')]
  [string]$LoginUser = 'counter2',
  [switch]$SkipInstall
)

$ErrorActionPreference = 'Stop'
$CounterTitle = (Get-Culture).TextInfo.ToTitleCase($LoginUser)

function Write-Step {
  param([string]$Message)
  Write-Host ''
  Write-Host "== $Message ==" -ForegroundColor Cyan
}

function Test-BadizoUrl {
  param([string]$Url, [int]$TimeoutSec = 2)
  try {
    $response = Invoke-WebRequest -UseBasicParsing -Uri $Url -TimeoutSec $TimeoutSec
    return ($response.StatusCode -ge 200 -and $response.StatusCode -lt 400)
  } catch {
    return $false
  }
}

function Get-LocalSubnetIps {
  $localIps = @(Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
    Where-Object {
      $_.IPAddress -notlike '127.*' -and
      $_.IPAddress -notlike '169.254.*' -and
      $_.PrefixOrigin -ne 'WellKnown'
    } |
    Select-Object -ExpandProperty IPAddress)

  $candidates = New-Object System.Collections.Generic.List[string]
  foreach ($ip in $localIps) {
    $parts = $ip.Split('.')
    if ($parts.Count -ne 4) { continue }
    for ($last = 1; $last -le 254; $last++) {
      $candidate = "$($parts[0]).$($parts[1]).$($parts[2]).$last"
      if ($candidate -ne $ip) {
        $candidates.Add($candidate)
      }
    }
  }

  return @($candidates | Select-Object -Unique)
}

function Resolve-BadizoServer {
  $preferredHosts = @(
    'badizo-server.local',
    'badizo-server',
    'server',
    'SERVER'
  )

  foreach ($hostName in $preferredHosts) {
    $healthUrl = "http://${hostName}:5000/api/health"
    Write-Host "Trying $healthUrl"
    if (Test-BadizoUrl -Url $healthUrl -TimeoutSec 3) {
      return $hostName
    }
  }

  Write-Host 'Scanning LAN for Badizo backend on port 5000...' -ForegroundColor Yellow
  foreach ($ip in Get-LocalSubnetIps) {
    if (Test-BadizoUrl -Url "http://${ip}:5000/api/health" -TimeoutSec 1) {
      return $ip
    }
  }

  return ''
}

function Find-Installer {
  if (![string]::IsNullOrWhiteSpace($InstallerPath)) {
    if (!(Test-Path $InstallerPath)) {
      throw "Installer not found: $InstallerPath"
    }
    return (Resolve-Path $InstallerPath).Path
  }

  $candidates = @(
    (Get-ChildItem -Path $PSScriptRoot -Filter 'Badizo Setup*.exe' -File -ErrorAction SilentlyContinue),
    (Get-ChildItem -Path (Get-Location) -Filter 'Badizo Setup*.exe' -File -ErrorAction SilentlyContinue)
  ) | ForEach-Object { $_ }

  $installer = $candidates | Sort-Object LastWriteTime -Descending | Select-Object -First 1
  if (!$installer) {
    throw 'Badizo installer was not found. Keep this fix file in the same folder as "Badizo Setup 1.0.0.exe".'
  }

  return $installer.FullName
}

function Install-Badizo {
  if ($SkipInstall) {
    Write-Host 'Skipping install because -SkipInstall was used.' -ForegroundColor Yellow
    return
  }

  Write-Step 'Installing latest Badizo app'
  $installer = Find-Installer
  Write-Host "Installer: $installer"
  Get-Process -Name Badizo -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue

  $process = Start-Process -FilePath $installer -ArgumentList '/S' -Wait -PassThru
  if ($process.ExitCode -ne 0) {
    Write-Host "Silent install returned exit code $($process.ExitCode). Opening normal installer..." -ForegroundColor Yellow
    $manualProcess = Start-Process -FilePath $installer -Wait -PassThru
    if ($manualProcess.ExitCode -ne 0) {
      throw "Installer failed with exit code $($manualProcess.ExitCode)."
    }
  }
}

function Write-CounterConfig {
  param([string]$ServerHost)

  Write-Step "Writing $CounterTitle LAN config"
  $appUrl = "http://${ServerHost}:5000"
  $counterAppUrl = "$appUrl`?loginMode=counter&loginUser=$LoginUser"

  $config = [ordered]@{
    appUrl = $counterAppUrl
    apiHealthUrl = "http://${ServerHost}:5000/api/health"
    serverHosts = @($ServerHost, 'badizo-server.local', 'badizo-server', 'server')
    discoveryEnabled = $true
    discoveryTimeoutMs = 12000
    backendPort = 5000
    frontendPort = 5000
    startBackend = $false
    startFrontend = $false
    loginMode = 'counter'
    loginUser = $LoginUser
    kiosk = $false
    devTools = $false
  }

  foreach ($name in @('Badizo', 'badizo-desktop')) {
    $configDir = Join-Path $env:APPDATA $name
    New-Item -ItemType Directory -Force -Path $configDir | Out-Null
    $configPath = Join-Path $configDir 'app-config.json'
    $config | ConvertTo-Json -Depth 4 | Set-Content -Path $configPath -Encoding UTF8
    Write-Host "Config written: $configPath" -ForegroundColor Green
  }

  return $counterAppUrl
}

function Find-BadizoExe {
  $possibleExePaths = @(
    (Join-Path $env:LOCALAPPDATA 'Programs\Badizo\Badizo.exe'),
    (Join-Path $env:ProgramFiles 'Badizo\Badizo.exe'),
    (Join-Path ${env:ProgramFiles(x86)} 'Badizo\Badizo.exe')
  ) | Where-Object { $_ -and (Test-Path $_) }

  return ($possibleExePaths | Select-Object -First 1)
}

function Find-BadizoIcon {
  param([string]$AppExe)

  $appDir = Split-Path -Parent $AppExe
  $candidates = @(
    (Join-Path $appDir 'resources\assets\badizo.ico'),
    (Join-Path $appDir 'assets\badizo.ico'),
    (Join-Path $PSScriptRoot 'badizo.ico'),
    $AppExe
  )

  return ($candidates | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1)
}

function Write-CounterLauncher {
  param(
    [string]$ServerHost,
    [string]$AppUrl
  )

  Write-Step "Creating $CounterTitle desktop launcher"
  $appExe = Find-BadizoExe
  if ([string]::IsNullOrWhiteSpace($appExe)) {
    Write-Host 'Badizo.exe was not found. Open Badizo from desktop shortcut after install finishes.' -ForegroundColor Yellow
    return
  }

  $desktop = [Environment]::GetFolderPath('Desktop')
  if ([string]::IsNullOrWhiteSpace($desktop)) {
    $desktop = Join-Path $env:USERPROFILE 'Desktop'
  }
  $launcherDir = Join-Path $env:APPDATA 'Badizo'
  New-Item -ItemType Directory -Force -Path $launcherDir | Out-Null
  $launcherPath = Join-Path $launcherDir "Badizo $CounterTitle Launcher.cmd"
  $hiddenLauncherPath = Join-Path $launcherDir "Badizo $CounterTitle Launcher.vbs"
  $launcherPs1Path = Join-Path $launcherDir "Badizo $CounterTitle Launcher.ps1"
  $launcherPs1Content = @"
`$ErrorActionPreference = 'SilentlyContinue'
`$appExe = '$($appExe.Replace("'", "''"))'
`$loginUser = '$($LoginUser.Replace("'", "''"))'
`$preferredHosts = @('$($ServerHost.Replace("'", "''"))', 'badizo-server.local', 'badizo-server', 'server', 'SERVER') | Where-Object { `$_ } | Select-Object -Unique

function Test-BadizoHealth {
  param([string]`$HostName, [int]`$TimeoutSec = 2)
  try {
    `$response = Invoke-WebRequest -UseBasicParsing -Uri "http://`$HostName`:5000/api/health" -TimeoutSec `$TimeoutSec
    return (`$response.StatusCode -ge 200 -and `$response.StatusCode -lt 400)
  } catch {
    return `$false
  }
}

function Get-LocalSubnetIps {
  `$ips = @(Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
    Where-Object { `$_.IPAddress -notlike '127.*' -and `$_.IPAddress -notlike '169.254.*' -and `$_.PrefixOrigin -ne 'WellKnown' } |
    Select-Object -ExpandProperty IPAddress)

  foreach (`$ip in `$ips) {
    `$parts = `$ip.Split('.')
    if (`$parts.Count -ne 4) { continue }
    for (`$last = 1; `$last -le 254; `$last++) {
      "`$(`$parts[0]).`$(`$parts[1]).`$(`$parts[2]).`$last"
    }
  }
}

`$serverHost = ''
foreach (`$hostName in `$preferredHosts) {
  if (Test-BadizoHealth -HostName `$hostName -TimeoutSec 3) {
    `$serverHost = `$hostName
    break
  }
}

if ([string]::IsNullOrWhiteSpace(`$serverHost)) {
  foreach (`$candidate in Get-LocalSubnetIps) {
    if (Test-BadizoHealth -HostName `$candidate -TimeoutSec 1) {
      `$serverHost = `$candidate
      break
    }
  }
}

if ([string]::IsNullOrWhiteSpace(`$serverHost)) {
  Add-Type -AssemblyName PresentationFramework
  [System.Windows.MessageBox]::Show('Badizo server was not found. Start server computer and check firewall port 5000.', 'Badizo Counter2') | Out-Null
  exit 1
}

`$env:BADIZO_APP_URL = "http://`$serverHost`:5000?loginMode=counter&loginUser=`$loginUser"
`$env:BADIZO_API_HEALTH_URL = "http://`$serverHost`:5000/api/health"
`$env:BADIZO_SERVER_HOSTS = (`$preferredHosts + `$serverHost | Select-Object -Unique) -join ','
Start-Process -FilePath `$appExe
"@
  $launcherPs1Content | Set-Content -Path $launcherPs1Path -Encoding ASCII
  Write-Host "Smart launcher written: $launcherPs1Path" -ForegroundColor Green

  $launcherContent = @"
@echo off
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "$launcherPs1Path"
endlocal
"@

  $launcherContent | Set-Content -Path $launcherPath -Encoding ASCII
  Write-Host "Launcher written: $launcherPath" -ForegroundColor Green

  $hiddenLauncherContent = @"
Set shell = CreateObject("WScript.Shell")
shell.Run """" & "$launcherPath" & """", 0, False
"@
  $hiddenLauncherContent | Set-Content -Path $hiddenLauncherPath -Encoding ASCII
  Write-Host "Hidden launcher written: $hiddenLauncherPath" -ForegroundColor Green

  $iconPath = Find-BadizoIcon -AppExe $appExe

  $shortcutTargets = @(
    (Join-Path $desktop 'Badizo.lnk'),
    (Join-Path $desktop "Badizo $CounterTitle.lnk")
  )

  $publicDesktop = Join-Path $env:PUBLIC 'Desktop'
  if (Test-Path $publicDesktop) {
    $shortcutTargets += (Join-Path $publicDesktop 'Badizo.lnk')
    $shortcutTargets += (Join-Path $publicDesktop "Badizo $CounterTitle.lnk")
  }

  $shell = New-Object -ComObject WScript.Shell
  foreach ($shortcutPath in @($shortcutTargets | Select-Object -Unique)) {
    try {
      $shortcut = $shell.CreateShortcut($shortcutPath)
      $shortcut.TargetPath = "$env:SystemRoot\System32\wscript.exe"
      $shortcut.Arguments = "`"$hiddenLauncherPath`""
      $shortcut.WorkingDirectory = Split-Path -Parent $appExe
      $shortcut.IconLocation = "$iconPath,0"
      $shortcut.Description = "Badizo $CounterTitle"
      $shortcut.Save()
      Write-Host "Shortcut updated: $shortcutPath" -ForegroundColor Green
    } catch {
      Write-Host "Could not update shortcut: $shortcutPath" -ForegroundColor Yellow
    }
  }
}

function Launch-Badizo {
  Write-Step "Launching $CounterTitle"
  $appExe = Find-BadizoExe
  if ([string]::IsNullOrWhiteSpace($appExe)) {
    Write-Host 'Badizo.exe was not found. Open Badizo from desktop shortcut after install finishes.' -ForegroundColor Yellow
    return
  }

  $launcherPath = Join-Path (Join-Path $env:APPDATA 'Badizo') "Badizo $CounterTitle Launcher.cmd"
  if (Test-Path $launcherPath) {
    Start-Process -FilePath $launcherPath
  } else {
    Start-Process -FilePath $appExe
  }
  Write-Host "Started: $appExe" -ForegroundColor Green
}

try {
  Write-Host "Badizo $CounterTitle permanent LAN fix" -ForegroundColor Green
  Install-Badizo

  Write-Step 'Finding Badizo server'
  $serverHost = Resolve-BadizoServer
  if ([string]::IsNullOrWhiteSpace($serverHost)) {
    throw 'Badizo server was not found on this LAN. On the server computer, run START_BADIZO_SERVER.bat and allow firewall port 5000.'
  }

  Write-Host "Badizo server found: $serverHost" -ForegroundColor Green
  $appUrl = Write-CounterConfig -ServerHost $serverHost
  Write-Host "$CounterTitle URL: $appUrl" -ForegroundColor Green
  Write-CounterLauncher -ServerHost $serverHost -AppUrl $appUrl
  Launch-Badizo

  Write-Host ''
  Write-Host "$CounterTitle fix completed successfully." -ForegroundColor Green
} catch {
  Write-Host ''
  Write-Host "$CounterTitle fix failed." -ForegroundColor Red
  Write-Host $_.Exception.Message -ForegroundColor Red
  exit 1
}
