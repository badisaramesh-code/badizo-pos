@echo off
setlocal

set "APP_ROOT=%~dp0"
set "SERVER_IP="

for /f "usebackq delims=" %%I in (`powershell -NoProfile -ExecutionPolicy Bypass -Command "Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' -and ($_.IPAddress -like '192.168.*' -or $_.IPAddress -like '10.*' -or $_.IPAddress -match '^172\.(1[6-9]|2[0-9]|3[0-1])\.') } | Select-Object -First 1 -ExpandProperty IPAddress"`) do set "SERVER_IP=%%I"

if "%SERVER_IP%"=="" (
  for /f "tokens=14 delims= " %%I in ('ipconfig ^| findstr /i "IPv4"') do (
    set "SERVER_IP=%%I"
    goto :server_ip_found
  )
)

:server_ip_found
if "%SERVER_IP%"=="" set "SERVER_IP=127.0.0.1"

echo Starting Badizo POS server...
echo.
echo Server LAN IP: %SERVER_IP%
echo.

set "NODE_EXE=C:\Program Files\nodejs\node.exe"
if not exist "%NODE_EXE%" (
  for /f "delims=" %%I in ('where node.exe 2^>nul') do (
    set "NODE_EXE=%%I"
    goto :node_found
  )
)

:node_found
if not exist "%NODE_EXE%" (
  echo.
  echo Node.js was not found in PATH. Install Node.js or restart this computer after installing it.
  pause
  exit /b 1
)

start "Badizo Backend Server" /min /D "%APP_ROOT%backend" "%NODE_EXE%" server.js
start "Badizo Frontend Server" /min /D "%APP_ROOT%" "%NODE_EXE%" scripts\windows\serve-frontend-build.js

echo.
echo Badizo POS server start command completed.
echo Frontend: http://%SERVER_IP%:3000
echo Frontend by computer name: http://%COMPUTERNAME%:3000
echo Backend:  http://%SERVER_IP%:5000/api/health
echo Backend by computer name:  http://%COMPUTERNAME%:5000/api/health
echo.

timeout /t 3 /nobreak >nul
start "" "http://%SERVER_IP%:3000"

pause

endlocal
