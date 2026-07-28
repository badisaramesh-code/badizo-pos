@echo off
setlocal

set "SERVER_HOST=192.168.1.9"
set "LOGIN_USER=counter2"
set "APP_URL=http://%SERVER_HOST%:5000?loginMode=counter&loginUser=%LOGIN_USER%"
set "SCRIPT=%TEMP%\badizo-counter2-localhost-error-fix.ps1"

title Badizo Counter2 localhost error fix

echo Badizo Counter2 localhost error permanent fix
echo.
echo Run this on the COUNTER2 computer as Administrator.
echo Server URL: %APP_URL%
echo.

echo Closing Badizo app if it is open...
taskkill /IM Badizo.exe /F >nul 2>nul
taskkill /IM electron.exe /F >nul 2>nul
timeout /t 2 /nobreak >nul

if exist "%SCRIPT%" del /f /q "%SCRIPT%" >nul 2>nul

> "%SCRIPT%" (
  echo $ErrorActionPreference = 'Continue'
  echo $serverHost = '%SERVER_HOST%'
  echo $loginUser = '%LOGIN_USER%'
  echo $appUrl = "http://${serverHost}:5000?loginMode=counter&loginUser=${loginUser}"
  echo $healthUrl = "http://${serverHost}:5000/api/health"
  echo Write-Host ''
  echo Write-Host "Writing Counter2 config to server $serverHost..." -ForegroundColor Cyan
  echo $config = [ordered]@{
  echo   appUrl = $appUrl
  echo   apiHealthUrl = $healthUrl
  echo   serverHosts = @($serverHost, 'badizo-server.local', 'badizo-server', 'server'^)
  echo   discoveryEnabled = $true
  echo   discoveryTimeoutMs = 15000
  echo   backendPort = 5000
  echo   frontendPort = 5000
  echo   startBackend = $false
  echo   startFrontend = $false
  echo   loginMode = 'counter'
  echo   loginUser = $loginUser
  echo   forcePackagedConfig = $true
  echo   kiosk = $false
  echo   devTools = $false
  echo }
  echo $json = $config ^| ConvertTo-Json -Depth 5
  echo $paths = @^(
  echo   (Join-Path $env:APPDATA 'Badizo\app-config.json'^),
  echo   (Join-Path $env:APPDATA 'badizo-desktop\app-config.json'^),
  echo   (Join-Path $env:LOCALAPPDATA 'Programs\Badizo\resources\app-config.json'^),
  echo   (Join-Path $env:ProgramFiles 'Badizo\resources\app-config.json'^),
  echo   'C:\Program Files ^(x86^)\Badizo\resources\app-config.json'
  echo ^)
  echo foreach ^($path in $paths^) {
  echo   try {
  echo     $dir = Split-Path -Parent $path
  echo     if ^($path -like "$env:APPDATA*" -or $path -like "$env:LOCALAPPDATA*" -or ^(Test-Path $dir^)^) {
  echo       New-Item -ItemType Directory -Force -Path $dir ^| Out-Null
  echo       $json ^| Set-Content -Path $path -Encoding UTF8 -Force
  echo       Write-Host "OK config: $path" -ForegroundColor Green
  echo     }
  echo   } catch {
  echo     Write-Host "FAILED config: $path" -ForegroundColor Red
  echo     Write-Host $_.Exception.Message -ForegroundColor Red
  echo   }
  echo }
  echo Write-Host ''
  echo Write-Host 'Creating browser fallback shortcut...' -ForegroundColor Cyan
  echo try {
  echo   $desktop = [Environment]::GetFolderPath^('Desktop'^)
  echo   $shortcutPath = Join-Path $desktop 'Badizo Counter2 Browser.url'
  echo   "[InternetShortcut]`r`nURL=$appUrl`r`n" ^| Set-Content -Path $shortcutPath -Encoding ASCII -Force
  echo   Write-Host "OK shortcut: $shortcutPath" -ForegroundColor Green
  echo } catch { Write-Host $_.Exception.Message -ForegroundColor Yellow }
  echo Write-Host ''
  echo Write-Host 'Testing server health...' -ForegroundColor Cyan
  echo try {
  echo   $response = Invoke-WebRequest -UseBasicParsing -Uri $healthUrl -TimeoutSec 8
  echo   Write-Host 'OK server health:' $healthUrl 'status' $response.StatusCode -ForegroundColor Green
  echo } catch {
  echo   Write-Host "FAILED server health: $healthUrl" -ForegroundColor Red
  echo   Write-Host $_.Exception.Message -ForegroundColor Red
  echo }
  echo Write-Host ''
  echo Write-Host "Done. Open Badizo app again. It must NOT show localhost now." -ForegroundColor Green
)

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT%"

echo.
pause
