@echo off
setlocal

set "SERVER_IP=192.168.1.9"
set "LOGIN_USER=counter2"
set "LOGIN_MODE=counter"
set "CONFIG_DIR=%APPDATA%\Badizo"
set "CONFIG_FILE=%CONFIG_DIR%\app-config.json"

echo Badizo Counter2 login fix
echo Server IP: %SERVER_IP%
echo Login User: %LOGIN_USER%
echo.

if not exist "%CONFIG_DIR%" mkdir "%CONFIG_DIR%"

> "%CONFIG_FILE%" echo {
>> "%CONFIG_FILE%" echo   "appUrl": "http://%SERVER_IP%:3000?loginMode=%LOGIN_MODE%^&loginUser=%LOGIN_USER%",
>> "%CONFIG_FILE%" echo   "apiHealthUrl": "http://%SERVER_IP%:5000/api/health",
>> "%CONFIG_FILE%" echo   "backendPort": 5000,
>> "%CONFIG_FILE%" echo   "frontendPort": 3000,
>> "%CONFIG_FILE%" echo   "startBackend": false,
>> "%CONFIG_FILE%" echo   "startFrontend": false,
>> "%CONFIG_FILE%" echo   "loginMode": "%LOGIN_MODE%",
>> "%CONFIG_FILE%" echo   "kiosk": false,
>> "%CONFIG_FILE%" echo   "devTools": false
>> "%CONFIG_FILE%" echo }

echo Config written:
echo %CONFIG_FILE%
echo.
type "%CONFIG_FILE%"
echo.
echo Close Badizo fully and open again. Login page should show Counter 2 and password only.
pause

endlocal
