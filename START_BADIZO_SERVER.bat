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
set "BACKEND_LOG=%APP_ROOT%backend-start.log"

echo Restarting Badizo POS server cleanly...
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

echo Stopping old Badizo server processes on ports 3000 and 5000...
powershell -NoProfile -ExecutionPolicy Bypass -Command "$ports=@(3000,5000); foreach($port in $ports){ Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue | ForEach-Object { try { Stop-Process -Id $_.OwningProcess -Force -ErrorAction Stop; Write-Host ('Stopped PID ' + $_.OwningProcess + ' on port ' + $port) } catch {} } }"

timeout /t 2 /nobreak >nul

echo Starting backend on port 5000...
start "Badizo Backend Server" /min /D "%APP_ROOT%backend" cmd /c ""%NODE_EXE%" server.js >> "%BACKEND_LOG%" 2>&1"

echo.
echo Waiting for Badizo to become ready...
powershell -NoProfile -ExecutionPolicy Bypass -Command "$ok=$false; for($i=1;$i -le 90;$i++){ $listener=Get-NetTCPConnection -LocalPort 5000 -State Listen -ErrorAction SilentlyContinue; if($listener){ Write-Host 'READY port 5000'; $ok=$true; break }; Start-Sleep -Seconds 1 }; if(-not $ok){ Write-Host 'NOT READY port 5000'; exit 1 }; for($i=1;$i -le 30;$i++){ try { $r=Invoke-WebRequest -UseBasicParsing -Uri 'http://localhost:5000/api/health' -TimeoutSec 3; if($r.StatusCode -ge 200 -and $r.StatusCode -lt 400){ Write-Host 'READY backend health'; exit 0 } } catch { Start-Sleep -Seconds 1 } }; Write-Host 'NOT READY backend health'; exit 1"
if errorlevel 1 (
  echo.
  echo Badizo server did not become ready. Check logs:
  echo %BACKEND_LOG%
  pause
  exit /b 1
)

echo.
echo Badizo POS server is ready.
echo Badizo app: http://%SERVER_IP%:5000
echo Badizo app by computer name: http://%COMPUTERNAME%:5000
echo Backend:  http://%SERVER_IP%:5000/api/health
echo Backend by computer name:  http://%COMPUTERNAME%:5000/api/health
echo.

echo Server services are running. Client systems can open Badizo from the server URLs above.

pause

endlocal
