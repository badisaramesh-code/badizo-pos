@echo off
setlocal

set "SERVER_HOST=DESKTOP-085I1KT"
set "ADMIN1_URL=http://%SERVER_HOST%:3000?loginMode=admin&loginUser=admin1"
set "APP_CONFIG_DIR=%APPDATA%\Badizo"
set "APP_CONFIG=%APP_CONFIG_DIR%\app-config.json"
set "APP_CONFIG_DIR_ALT=%APPDATA%\badizo-desktop"
set "APP_CONFIG_ALT=%APP_CONFIG_DIR_ALT%\app-config.json"
set "DESKTOP_LAUNCHER=%USERPROFILE%\Desktop\Badizo Admin1.bat"
set "PUBLIC_DESKTOP_LAUNCHER=%PUBLIC%\Desktop\Badizo Admin1.bat"
set "BADIZO_EXE=%LOCALAPPDATA%\Programs\Badizo\Badizo.exe"
set "BADIZO_EXE_PROGRAMFILES=%ProgramFiles%\Badizo\Badizo.exe"
set "BADIZO_EXE_PROGRAMFILES_X86=%ProgramFiles(x86)%\Badizo\Badizo.exe"

title Badizo Admin1 Permanent Fix

echo Badizo Admin1 Permanent Fix
echo Server: %SERVER_HOST%
echo Admin login: admin1
echo.

if not exist "%APP_CONFIG_DIR%" mkdir "%APP_CONFIG_DIR%"
if not exist "%APP_CONFIG_DIR_ALT%" mkdir "%APP_CONFIG_DIR_ALT%"

taskkill /IM Badizo.exe /F >nul 2>nul

call :write_config "%APP_CONFIG%"
call :write_config "%APP_CONFIG_ALT%"

call :write_launcher "%DESKTOP_LAUNCHER%"
call :write_launcher "%PUBLIC_DESKTOP_LAUNCHER%"

echo Config written:
echo %APP_CONFIG%
echo %APP_CONFIG_ALT%
echo.
echo Desktop launcher created:
echo Badizo Admin1
echo.

if exist "%BADIZO_EXE%" (
  set "BADIZO_APP_URL=%ADMIN1_URL%"
  set "BADIZO_API_HEALTH_URL=http://%SERVER_HOST%:5000/api/health"
  start "" "%BADIZO_EXE%"
) else if exist "%BADIZO_EXE_PROGRAMFILES%" (
  set "BADIZO_APP_URL=%ADMIN1_URL%"
  set "BADIZO_API_HEALTH_URL=http://%SERVER_HOST%:5000/api/health"
  start "" "%BADIZO_EXE_PROGRAMFILES%"
) else if exist "%BADIZO_EXE_PROGRAMFILES_X86%" (
  set "BADIZO_APP_URL=%ADMIN1_URL%"
  set "BADIZO_API_HEALTH_URL=http://%SERVER_HOST%:5000/api/health"
  start "" "%BADIZO_EXE_PROGRAMFILES_X86%"
) else (
  echo Badizo app install not found. Run Badizo Setup 1.0.0.exe, then run this fix again.
)

echo.
pause
exit /b 0

:write_config
> "%~1" echo {
>> "%~1" echo   "appUrl": "http://%SERVER_HOST%:3000?loginMode=admin^&loginUser=admin1",
>> "%~1" echo   "apiHealthUrl": "http://%SERVER_HOST%:5000/api/health",
>> "%~1" echo   "backendPort": 5000,
>> "%~1" echo   "frontendPort": 3000,
>> "%~1" echo   "startBackend": false,
>> "%~1" echo   "startFrontend": false,
>> "%~1" echo   "loginMode": "admin",
>> "%~1" echo   "kiosk": false,
>> "%~1" echo   "devTools": false
>> "%~1" echo }
exit /b 0

:write_launcher
> "%~1" echo @echo off
>> "%~1" echo set "SERVER_HOST=%SERVER_HOST%"
>> "%~1" echo set "BADIZO_APP_URL=http://%%SERVER_HOST%%:3000?loginMode=admin^&loginUser=admin1"
>> "%~1" echo set "BADIZO_API_HEALTH_URL=http://%%SERVER_HOST%%:5000/api/health"
>> "%~1" echo if exist "%%LOCALAPPDATA%%\Programs\Badizo\Badizo.exe" start "" "%%LOCALAPPDATA%%\Programs\Badizo\Badizo.exe" ^& exit /b
>> "%~1" echo if exist "%%ProgramFiles%%\Badizo\Badizo.exe" start "" "%%ProgramFiles%%\Badizo\Badizo.exe" ^& exit /b
>> "%~1" echo if exist "%%ProgramFiles(x86)%%\Badizo\Badizo.exe" start "" "%%ProgramFiles(x86)%%\Badizo\Badizo.exe" ^& exit /b
>> "%~1" echo echo Badizo.exe not found. Install Badizo first.
>> "%~1" echo pause
exit /b 0

endlocal
