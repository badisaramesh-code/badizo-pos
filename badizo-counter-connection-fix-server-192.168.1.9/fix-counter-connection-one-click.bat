@echo off
setlocal

set "SERVER_IP=192.168.1.9"
set "CONFIG_DIR=%APPDATA%\Badizo"
set "CONFIG_FILE=%CONFIG_DIR%\app-config.json"

echo Badizo counter connection fix
echo Server IP: %SERVER_IP%
echo.

echo Checking server frontend...
powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "if ((Test-NetConnection -ComputerName '%SERVER_IP%' -Port 3000 -WarningAction SilentlyContinue).TcpTestSucceeded) { Write-Host 'Frontend OK: http://%SERVER_IP%:3000' -ForegroundColor Green } else { Write-Host 'Frontend NOT reachable: http://%SERVER_IP%:3000' -ForegroundColor Red }"

echo.
echo Checking server backend...
powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "if ((Test-NetConnection -ComputerName '%SERVER_IP%' -Port 5000 -WarningAction SilentlyContinue).TcpTestSucceeded) { Write-Host 'Backend OK: http://%SERVER_IP%:5000/api/health' -ForegroundColor Green } else { Write-Host 'Backend NOT reachable: http://%SERVER_IP%:5000/api/health' -ForegroundColor Red }"

echo.
echo Writing Badizo app config...
if not exist "%CONFIG_DIR%" mkdir "%CONFIG_DIR%"

> "%CONFIG_FILE%" echo {
>> "%CONFIG_FILE%" echo   "appUrl": "http://%SERVER_IP%:3000",
>> "%CONFIG_FILE%" echo   "apiHealthUrl": "http://%SERVER_IP%:5000/api/health",
>> "%CONFIG_FILE%" echo   "backendPort": 5000,
>> "%CONFIG_FILE%" echo   "frontendPort": 3000,
>> "%CONFIG_FILE%" echo   "startBackend": false,
>> "%CONFIG_FILE%" echo   "startFrontend": false,
>> "%CONFIG_FILE%" echo   "loginMode": "counter",
>> "%CONFIG_FILE%" echo   "kiosk": false,
>> "%CONFIG_FILE%" echo   "devTools": false
>> "%CONFIG_FILE%" echo }

echo Config written:
echo %CONFIG_FILE%
echo.
type "%CONFIG_FILE%"

echo.
echo Close Badizo app fully, then open Badizo again.
echo If frontend/backend show NOT reachable above, fix server firewall/network first.
echo.
pause

endlocal
