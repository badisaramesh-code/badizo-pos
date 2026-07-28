@echo off
setlocal

set "APPDATA_DIR=%APPDATA%"
if "%APPDATA_DIR%"=="" set "APPDATA_DIR=%USERPROFILE%\AppData\Roaming"

set "CONFIG1=%APPDATA_DIR%\Badizo\app-config.json"
set "CONFIG2=%APPDATA_DIR%\badizo-desktop\app-config.json"

for %%D in ("%APPDATA_DIR%\Badizo" "%APPDATA_DIR%\badizo-desktop") do (
  if not exist "%%~D" mkdir "%%~D"
)

(
echo {
echo   "appUrl": "http://192.168.1.8:5000?loginMode=counter^&loginUser=counter2",
echo   "apiHealthUrl": "http://192.168.1.8:5000/api/health",
echo   "serverHosts": [
echo     "192.168.1.8",
echo     "DESKTOP-085I1KT"
echo   ],
echo   "discoveryEnabled": true,
echo   "discoveryTimeoutMs": 12000,
echo   "backendPort": 5000,
echo   "frontendPort": 3000,
echo   "startBackend": false,
echo   "startFrontend": false,
echo   "loginMode": "counter",
echo   "loginUser": "counter2",
echo   "kiosk": false,
echo   "devTools": false
echo }
) > "%CONFIG1%"

copy /Y "%CONFIG1%" "%CONFIG2%" >nul

taskkill /IM Badizo.exe /F >nul 2>nul

echo.
echo Counter2 Badizo app config updated.
echo Server: 192.168.1.8
echo Login: counter2
echo.
echo Now double-click the original Badizo app icon.
pause

endlocal
