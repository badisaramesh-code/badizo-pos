@echo off
setlocal

set "SERVER_HOST=DESKTOP-085I1KT"
set "COUNTER2_URL=http://%SERVER_HOST%:3000?loginMode=counter&loginUser=counter2"
set "APP_CONFIG_DIR=%APPDATA%\Badizo"
set "APP_CONFIG=%APP_CONFIG_DIR%\app-config.json"
set "APP_CONFIG_DIR_ALT=%APPDATA%\badizo-desktop"
set "APP_CONFIG_ALT=%APP_CONFIG_DIR_ALT%\app-config.json"
set "BADIZO_EXE=%LOCALAPPDATA%\Programs\Badizo\Badizo.exe"
set "BADIZO_EXE_PROGRAMFILES=%ProgramFiles%\Badizo\Badizo.exe"
set "BADIZO_EXE_PROGRAMFILES_X86=%ProgramFiles(x86)%\Badizo\Badizo.exe"
set "BADIZO_DESKTOP_SHORTCUT=%USERPROFILE%\Desktop\Badizo.lnk"
set "BADIZO_PUBLIC_DESKTOP_SHORTCUT=%PUBLIC%\Desktop\Badizo.lnk"

title Badizo Counter2 Login Only Fix

echo Fixing Badizo Counter2 login screen...
echo Server: %SERVER_HOST%
echo Counter login: counter2
echo Counter2 URL: http://%SERVER_HOST%:3000?loginMode=counter^&loginUser=counter2
echo.

if not exist "%APP_CONFIG_DIR%" mkdir "%APP_CONFIG_DIR%"
if not exist "%APP_CONFIG_DIR_ALT%" mkdir "%APP_CONFIG_DIR_ALT%"

taskkill /IM Badizo.exe /F >nul 2>nul

call :WRITE_CONFIG "%APP_CONFIG%"
call :WRITE_CONFIG "%APP_CONFIG_ALT%"

echo Config written:
echo %APP_CONFIG%
echo %APP_CONFIG_ALT%
echo.

if exist "%BADIZO_EXE%" (
  set "BADIZO_APP_URL=%COUNTER2_URL%"
  set "BADIZO_API_HEALTH_URL=http://%SERVER_HOST%:5000/api/health"
  start "" "%BADIZO_EXE%"
) else if exist "%BADIZO_EXE_PROGRAMFILES%" (
  set "BADIZO_APP_URL=%COUNTER2_URL%"
  set "BADIZO_API_HEALTH_URL=http://%SERVER_HOST%:5000/api/health"
  start "" "%BADIZO_EXE_PROGRAMFILES%"
) else if exist "%BADIZO_EXE_PROGRAMFILES_X86%" (
  set "BADIZO_APP_URL=%COUNTER2_URL%"
  set "BADIZO_API_HEALTH_URL=http://%SERVER_HOST%:5000/api/health"
  start "" "%BADIZO_EXE_PROGRAMFILES_X86%"
) else if exist "%BADIZO_DESKTOP_SHORTCUT%" (
  start "" "%BADIZO_DESKTOP_SHORTCUT%"
) else if exist "%BADIZO_PUBLIC_DESKTOP_SHORTCUT%" (
  start "" "%BADIZO_PUBLIC_DESKTOP_SHORTCUT%"
) else (
  echo Badizo app install not found.
  echo First run RUN_COUNTER2_HOSTNAME_ONE_CLICK.bat from this same folder.
  echo After install completes, run this FIX_COUNTER2_LOGIN_ONLY.bat again if needed.
)

echo.
pause

endlocal
exit /b 0

:WRITE_CONFIG
if exist "%~1" copy /Y "%~1" "%~1.backup" >nul 2>nul
> "%~1" echo {
>> "%~1" echo   "appUrl": "http://%SERVER_HOST%:3000?loginMode=counter^&loginUser=counter2",
>> "%~1" echo   "apiHealthUrl": "http://%SERVER_HOST%:5000/api/health",
>> "%~1" echo   "backendPort": 5000,
>> "%~1" echo   "frontendPort": 3000,
>> "%~1" echo   "startBackend": false,
>> "%~1" echo   "startFrontend": false,
>> "%~1" echo   "loginMode": "counter",
>> "%~1" echo   "kiosk": false,
>> "%~1" echo   "devTools": false
>> "%~1" echo }
exit /b 0
