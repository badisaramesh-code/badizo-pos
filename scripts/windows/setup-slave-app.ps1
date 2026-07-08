param(
  [string]$ServerIp = '',
  [string[]]$ServerHosts = @(),
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

function Test-BadizoUrl {
  param([string]$Url, [int]$TimeoutSec = 3)
  try {
    $response = Invoke-WebRequest -UseBasicParsing -Uri $Url -TimeoutSec $TimeoutSec
    return ($response.StatusCode -ge 200 -and $response.StatusCode -lt 400)
  } catch {
    return $false
  }
}

function Get-LocalSubnetIps {
  $ips = @(Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
    Where-Object {
      $_.IPAddress -notlike '127.*' -and
      $_.IPAddress -notlike '169.254.*' -and
      $_.PrefixOrigin -ne 'WellKnown'
    } |
    Select-Object -ExpandProperty IPAddress)

  $candidates = New-Object System.Collections.Generic.List[string]
  foreach ($ip in $ips) {
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
  $candidateHosts = New-Object System.Collections.Generic.List[string]
  if (![string]::IsNullOrWhiteSpace($ServerIp)) {
    $candidateHosts.Add($ServerIp.Trim())
  }
  foreach ($hostName in $ServerHosts) {
    if (![string]::IsNullOrWhiteSpace($hostName)) {
      $candidateHosts.Add($hostName.Trim())
    }
  }
  foreach ($hostName in @('badizo-server.local', 'badizo-server', 'BADIZO-SERVER', 'server', 'SERVER')) {
    $candidateHosts.Add($hostName)
  }

  foreach ($hostName in @($candidateHosts | Select-Object -Unique)) {
    $healthUrl = "http://${hostName}:5000/api/health"
    Write-Host "Trying $healthUrl"
    if (Test-BadizoUrl -Url $healthUrl -TimeoutSec 4) {
      return $hostName
    }
  }

  Write-Host 'Saved server address was not reachable. Scanning this LAN for Badizo server on port 5000...' -ForegroundColor Yellow
  foreach ($ip in Get-LocalSubnetIps) {
    if (Test-BadizoUrl -Url "http://${ip}:5000/api/health" -TimeoutSec 1) {
      return $ip
    }
  }

  return ''
}

function Test-Server {
  if ($SkipServerCheck) {
    Write-Host 'Skipping server pre-check because -SkipServerCheck was used.' -ForegroundColor Yellow
    return
  }

  Write-Step 'Checking server connection'
  $script:ResolvedServerHost = Resolve-BadizoServer
  if ([string]::IsNullOrWhiteSpace($script:ResolvedServerHost)) {
    throw 'Cannot find Badizo server on this LAN. Start the server computer, run START_BADIZO_SERVER.bat once, and allow Windows Firewall port 5000.'
  }

  $frontend5000 = "http://${script:ResolvedServerHost}:5000"
  if (!(Test-BadizoUrl -Url $frontend5000 -TimeoutSec 8)) {
    throw "Badizo backend was found, but frontend did not open at ${frontend5000}."
  }

  Write-Host "Badizo server found: $script:ResolvedServerHost" -ForegroundColor Green
  Write-Host "Frontend OK: $frontend5000" -ForegroundColor Green
  Write-Host "Server OK: http://${script:ResolvedServerHost}:5000/api/health" -ForegroundColor Green
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

  $serverHost = $script:ResolvedServerHost
  if ([string]::IsNullOrWhiteSpace($serverHost)) {
    $serverHost = $ServerIp
  }
  if ([string]::IsNullOrWhiteSpace($serverHost)) {
    $serverHost = 'badizo-server'
  }
  $allServerHosts = @($serverHost, $ServerIp) + $ServerHosts + @('badizo-server.local', 'badizo-server', 'server')
  $allServerHosts = @($allServerHosts | Where-Object { ![string]::IsNullOrWhiteSpace($_) } | ForEach-Object { $_.Trim() } | Select-Object -Unique)
  $appUrl = "http://${serverHost}:5000"
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
    apiHealthUrl = "http://${serverHost}:5000/api/health"
    serverHosts = $allServerHosts
    discoveryEnabled = $true
    discoveryTimeoutMs = 12000
    backendPort = 5000
    frontendPort = 3000
    startBackend = $false
    startFrontend = $false
    loginMode = $LoginMode
    loginUser = $LoginUser
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
  Write-Host "Server IP/host: $ServerIp"
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
