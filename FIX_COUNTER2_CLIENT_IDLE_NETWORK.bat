@echo off
setlocal

net session >nul 2>&1
if errorlevel 1 (
  powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "Start-Process -Verb RunAs -FilePath '%~f0'"
  exit /b
)

set "SERVER_HOST=192.168.1.10"
set "SCRIPT=%TEMP%\badizo-counter2-client-idle-network.ps1"

title Badizo Counter2 Idle Network Fix

echo Badizo Counter2 idle network permanent fix
echo.
echo This must be run on the Counter2 computer.
echo Server: %SERVER_HOST%
echo.

echo Closing old Badizo app processes so config files can be updated...
taskkill /IM Badizo.exe /F >nul 2>nul
taskkill /IM electron.exe /F >nul 2>nul
timeout /t 2 /nobreak >nul
if exist "%SCRIPT%" del /f /q "%SCRIPT%" >nul 2>nul

> "%SCRIPT%" (
  echo param([string]$ServerHost = '192.168.1.10', [string]$LoginUser = 'counter2'^)
  echo $ErrorActionPreference = 'Continue'
  echo function Step([string]$m^) { Write-Host ''; Write-Host "== $m ==" -ForegroundColor Cyan }
  echo Step "Writing Badizo Counter2 config"
  echo $counterAppUrl = "http://${ServerHost}:5000?loginMode=counter&loginUser=$LoginUser"
  echo $config = [ordered]@{ appUrl = $counterAppUrl; apiHealthUrl = "http://${ServerHost}:5000/api/health"; serverHosts = @($ServerHost, 'badizo-server.local', 'badizo-server', 'server'^); discoveryEnabled = $true; discoveryTimeoutMs = 15000; backendPort = 5000; frontendPort = 5000; startBackend = $false; startFrontend = $false; loginMode = 'counter'; loginUser = $LoginUser; kiosk = $false; devTools = $false }
  echo foreach ($name in @('Badizo', 'badizo-desktop'^)^) { $configDir = Join-Path $env:APPDATA $name; New-Item -ItemType Directory -Force -Path $configDir ^| Out-Null; $configPath = Join-Path $configDir 'app-config.json'; $config ^| ConvertTo-Json -Depth 4 ^| Set-Content -Path $configPath -Encoding UTF8; Write-Host "Config written: $configPath" -ForegroundColor Green }
  echo $installedConfig = Join-Path $env:LOCALAPPDATA 'Programs\Badizo\resources\app-config.json'
  echo if (Test-Path (Split-Path -Parent $installedConfig^)^) { try { $config ^| ConvertTo-Json -Depth 4 ^| Set-Content -Path $installedConfig -Encoding UTF8; Write-Host "Installed config written: $installedConfig" -ForegroundColor Green } catch { Write-Host ('Installed config update skipped: ' + $_.Exception.Message^) -ForegroundColor Yellow } }
  echo Step 'Disabling Windows idle network power saving'
  echo try { powercfg /change standby-timeout-ac 0 ^| Out-Null; powercfg /setacvalueindex SCHEME_CURRENT SUB_PCIEXPRESS ASPM 0 ^| Out-Null; powercfg /setactive SCHEME_CURRENT ^| Out-Null; Write-Host 'Power plan updated.' -ForegroundColor Green } catch { Write-Host ('Power plan skipped: ' + $_.Exception.Message^) -ForegroundColor Yellow }
  echo try { Get-NetAdapter -Physical -ErrorAction SilentlyContinue ^| Where-Object { $_.Status -ne 'Disabled' } ^| ForEach-Object { try { Set-NetAdapterPowerManagement -Name $_.Name -SelectiveSuspend Disabled -DeviceSleepOnDisconnect Disabled -NoRestart -ErrorAction Stop; Write-Host ('Adapter power saving disabled: ' + $_.Name^) -ForegroundColor Green } catch { Write-Host ('Adapter power saving skipped: ' + $_.Name^) -ForegroundColor Yellow }; foreach ($displayName in @('Energy Efficient Ethernet','Green Ethernet','Power Saving Mode'^)^) { try { Set-NetAdapterAdvancedProperty -Name $_.Name -DisplayName $displayName -DisplayValue 'Disabled' -NoRestart -ErrorAction Stop; Write-Host ($displayName + ' disabled: ' + $_.Name^) -ForegroundColor Green } catch {} } } } catch { Write-Host ('Adapter update skipped: ' + $_.Exception.Message^) -ForegroundColor Yellow }
  echo Step 'Installing Badizo LAN keepalive'
  echo $badizoDir = Join-Path $env:APPDATA 'Badizo'; New-Item -ItemType Directory -Force -Path $badizoDir ^| Out-Null
  echo $keepAlivePath = Join-Path $badizoDir 'Badizo Counter2 LAN Keepalive.ps1'
  echo $keepAliveLog = Join-Path $badizoDir 'counter2-lan-keepalive.log'
  echo $keepAlive = @"
  echo `$serverHost = '$ServerHost'
  echo `$healthUrl = "http://`$serverHost`:5000/api/health"
  echo `$logPath = '$keepAliveLog'
  echo while (`$true^) {
  echo   try {
  echo     `$result = Invoke-WebRequest -UseBasicParsing -Uri `$healthUrl -TimeoutSec 4
  echo     if (`$result.StatusCode -ge 200 -and `$result.StatusCode -lt 400^) { "`${(Get-Date^).ToString('s'^)} OK `$healthUrl" ^| Set-Content -Path `$logPath -Encoding ASCII }
  echo   } catch { "`${(Get-Date^).ToString('s'^)} FAIL `$healthUrl `$(`$_.Exception.Message^)" ^| Set-Content -Path `$logPath -Encoding ASCII }
  echo   Start-Sleep -Seconds 30
  echo }
  echo "@
  echo $keepAlive ^| Set-Content -Path $keepAlivePath -Encoding ASCII
  echo $startupDir = [Environment]::GetFolderPath('Startup'^)
  echo $launcherPath = Join-Path $badizoDir 'Badizo Counter2 LAN Keepalive.cmd'
  echo $hiddenLauncherPath = Join-Path $startupDir 'Badizo Counter2 LAN Keepalive.vbs'
  echo "@echo off`r`npowershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$keepAlivePath`"`r`n" ^| Set-Content -Path $launcherPath -Encoding ASCII
  echo "Set shell = CreateObject(`"WScript.Shell`")`r`nshell.Run `"`"`"$launcherPath`"`"`", 0, False`r`n" ^| Set-Content -Path $hiddenLauncherPath -Encoding ASCII
  echo Start-Process -FilePath $launcherPath -WindowStyle Hidden
  echo Write-Host "Keepalive installed: $hiddenLauncherPath" -ForegroundColor Green
  echo Step 'Testing server connection'
  echo try { $healthUrl = "http://${ServerHost}:5000/api/health"; $response = Invoke-WebRequest -UseBasicParsing -Uri $healthUrl -TimeoutSec 6; Write-Host ('OK: ' + $healthUrl + ' status ' + $response.StatusCode^) -ForegroundColor Green } catch { Write-Host "FAILED: http://${ServerHost}:5000/api/health" -ForegroundColor Red; Write-Host $_.Exception.Message -ForegroundColor Red }
  echo Write-Host ''; Write-Host 'Done. Close and reopen Badizo Counter2.' -ForegroundColor Green
)

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT%" -ServerHost "%SERVER_HOST%" -LoginUser counter2

echo.
pause
