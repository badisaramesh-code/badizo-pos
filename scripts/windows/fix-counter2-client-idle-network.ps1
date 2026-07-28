param(
  [string]$ServerHost = '192.168.1.10',
  [ValidatePattern('^counter[1-6]$')]
  [string]$LoginUser = 'counter2'
)

$ErrorActionPreference = 'Continue'

function Write-Step {
  param([string]$Message)
  Write-Host ''
  Write-Host "== $Message ==" -ForegroundColor Cyan
}

function Write-CounterConfig {
  Write-Step "Writing Badizo $LoginUser config"
  $counterAppUrl = "http://${ServerHost}:5000?loginMode=counter&loginUser=$LoginUser"
  $config = [ordered]@{
    appUrl = $counterAppUrl
    apiHealthUrl = "http://${ServerHost}:5000/api/health"
    serverHosts = @($ServerHost, 'badizo-server.local', 'badizo-server', 'server')
    discoveryEnabled = $true
    discoveryTimeoutMs = 15000
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

  $installedConfig = Join-Path $env:LOCALAPPDATA 'Programs\Badizo\resources\app-config.json'
  if (Test-Path (Split-Path -Parent $installedConfig)) {
    try {
      $config | ConvertTo-Json -Depth 4 | Set-Content -Path $installedConfig -Encoding UTF8
      Write-Host "Installed config written: $installedConfig" -ForegroundColor Green
    } catch {
      Write-Host "Installed config update skipped: $($_.Exception.Message)" -ForegroundColor Yellow
    }
  }
}

function Disable-NetworkSleep {
  Write-Step 'Disabling Windows idle network power saving'

  try {
    powercfg /change standby-timeout-ac 0 | Out-Null
    powercfg /setacvalueindex SCHEME_CURRENT SUB_PCIEXPRESS ASPM 0 | Out-Null
    powercfg /setactive SCHEME_CURRENT | Out-Null
    Write-Host 'Power plan updated for AC power.' -ForegroundColor Green
  } catch {
    Write-Host "Power plan update skipped: $($_.Exception.Message)" -ForegroundColor Yellow
  }

  try {
    Get-NetAdapter -Physical -ErrorAction SilentlyContinue |
      Where-Object { $_.Status -ne 'Disabled' } |
      ForEach-Object {
        try {
          Set-NetAdapterPowerManagement -Name $_.Name -SelectiveSuspend Disabled -DeviceSleepOnDisconnect Disabled -NoRestart -ErrorAction Stop
          Write-Host "Adapter power saving disabled: $($_.Name)" -ForegroundColor Green
        } catch {
          Write-Host "Adapter power saving skipped: $($_.Name)" -ForegroundColor Yellow
        }

        foreach ($displayName in @('Energy Efficient Ethernet', 'Green Ethernet', 'Power Saving Mode')) {
          try {
            Set-NetAdapterAdvancedProperty -Name $_.Name -DisplayName $displayName -DisplayValue 'Disabled' -NoRestart -ErrorAction Stop
            Write-Host "$displayName disabled: $($_.Name)" -ForegroundColor Green
          } catch {}
        }
      }
  } catch {
    Write-Host "Adapter update skipped: $($_.Exception.Message)" -ForegroundColor Yellow
  }
}

function Install-KeepAlive {
  Write-Step 'Installing Badizo Counter2 LAN keepalive'
  $badizoDir = Join-Path $env:APPDATA 'Badizo'
  New-Item -ItemType Directory -Force -Path $badizoDir | Out-Null

  $keepAlivePath = Join-Path $badizoDir 'Badizo Counter2 LAN Keepalive.ps1'
  $keepAliveLog = Join-Path $badizoDir 'counter2-lan-keepalive.log'
  $content = @"
`$serverHost = '$($ServerHost.Replace("'", "''"))'
`$healthUrl = "http://`$serverHost`:5000/api/health"
`$logPath = '$($keepAliveLog.Replace("'", "''"))'
while (`$true) {
  try {
    `$result = Invoke-WebRequest -UseBasicParsing -Uri `$healthUrl -TimeoutSec 4
    if (`$result.StatusCode -ge 200 -and `$result.StatusCode -lt 400) {
      "`${(Get-Date).ToString('s')} OK `$healthUrl" | Set-Content -Path `$logPath -Encoding ASCII
    }
  } catch {
    "`${(Get-Date).ToString('s')} FAIL `$healthUrl `$(`$_.Exception.Message)" | Set-Content -Path `$logPath -Encoding ASCII
  }
  Start-Sleep -Seconds 30
}
"@
  $content | Set-Content -Path $keepAlivePath -Encoding ASCII

  $startupDir = [Environment]::GetFolderPath('Startup')
  $launcherPath = Join-Path $badizoDir 'Badizo Counter2 LAN Keepalive.cmd'
  $hiddenLauncherPath = Join-Path $startupDir 'Badizo Counter2 LAN Keepalive.vbs'

  "@echo off`r`npowershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$keepAlivePath`"`r`n" |
    Set-Content -Path $launcherPath -Encoding ASCII

  "Set shell = CreateObject(`"WScript.Shell`")`r`nshell.Run `"`"`"$launcherPath`"`"`", 0, False`r`n" |
    Set-Content -Path $hiddenLauncherPath -Encoding ASCII

  Start-Process -FilePath $launcherPath -WindowStyle Hidden
  Write-Host "Keepalive installed: $hiddenLauncherPath" -ForegroundColor Green
}

function Test-BadizoConnection {
  Write-Step 'Testing server connection'
  try {
    $healthUrl = "http://${ServerHost}:5000/api/health"
    $response = Invoke-WebRequest -UseBasicParsing -Uri $healthUrl -TimeoutSec 6
    Write-Host "OK: $healthUrl status $($response.StatusCode)" -ForegroundColor Green
  } catch {
    Write-Host "FAILED: http://${ServerHost}:5000/api/health" -ForegroundColor Red
    Write-Host $_.Exception.Message -ForegroundColor Red
  }
}

Write-Host 'Badizo Counter2 idle network permanent fix' -ForegroundColor Green
Write-CounterConfig
Disable-NetworkSleep
Install-KeepAlive
Test-BadizoConnection
Write-Host ''
Write-Host 'Done. Close and reopen Badizo Counter2.' -ForegroundColor Green
