@echo off
setlocal

set "SERVER_HOST=192.168.1.10"
set "COUNTER1_URL=http://%SERVER_HOST%:3000?loginMode=counter&loginUser=counter1"
set "APP_CONFIG_DIR=%APPDATA%\Badizo"
set "APP_CONFIG=%APP_CONFIG_DIR%\app-config.json"
set "APP_CONFIG_DIR_ALT=%APPDATA%\badizo-desktop"
set "APP_CONFIG_ALT=%APP_CONFIG_DIR_ALT%\app-config.json"
set "ROLE_LAUNCHER_DIR=%APPDATA%\BadizoLaunchers"
set "ROLE_LAUNCHER_CMD=%ROLE_LAUNCHER_DIR%\Badizo Counter1.cmd"
set "DESKTOP_SHORTCUT=%USERPROFILE%\Desktop\Badizo.lnk"
set "PUBLIC_DESKTOP_SHORTCUT=%PUBLIC%\Desktop\Badizo.lnk"
set "OLD_DESKTOP_LAUNCHER=%USERPROFILE%\Desktop\Badizo Counter1.bat"
set "OLD_PUBLIC_DESKTOP_LAUNCHER=%PUBLIC%\Desktop\Badizo Counter1.bat"
set "BADIZO_EXE=%LOCALAPPDATA%\Programs\Badizo\Badizo.exe"
set "BADIZO_EXE_PROGRAMFILES=%ProgramFiles%\Badizo\Badizo.exe"
set "BADIZO_EXE_PROGRAMFILES_X86=%ProgramFiles(x86)%\Badizo\Badizo.exe"

title Badizo Counter1 Permanent Fix

echo Badizo Counter1 Permanent Fix
echo Server: %SERVER_HOST%
echo Counter login: counter1
echo.

if not exist "%APP_CONFIG_DIR%" mkdir "%APP_CONFIG_DIR%"
if not exist "%APP_CONFIG_DIR_ALT%" mkdir "%APP_CONFIG_DIR_ALT%"
if not exist "%ROLE_LAUNCHER_DIR%" mkdir "%ROLE_LAUNCHER_DIR%"

taskkill /IM Badizo.exe /F >nul 2>nul

if exist "%~dp0Badizo Setup 1.0.0.exe" (
  echo Installing/updating Badizo app...
  start /wait "" "%~dp0Badizo Setup 1.0.0.exe" /S
  echo.
)

call :write_config "%APP_CONFIG%"
call :write_config "%APP_CONFIG_ALT%"

call :write_launcher "%ROLE_LAUNCHER_CMD%"
call :write_shortcut "%DESKTOP_SHORTCUT%"
call :write_shortcut "%PUBLIC_DESKTOP_SHORTCUT%"
del "%OLD_DESKTOP_LAUNCHER%" >nul 2>nul
del "%OLD_PUBLIC_DESKTOP_LAUNCHER%" >nul 2>nul

echo Config written:
echo %APP_CONFIG%
echo %APP_CONFIG_ALT%
echo.
echo Desktop shortcut updated:
echo Badizo
echo.

if exist "%BADIZO_EXE%" (
  set "BADIZO_APP_URL=%COUNTER1_URL%"
  set "BADIZO_API_HEALTH_URL=http://%SERVER_HOST%:5000/api/health"
  start "" "%BADIZO_EXE%" --force-device-scale-factor=0.85
) else if exist "%BADIZO_EXE_PROGRAMFILES%" (
  set "BADIZO_APP_URL=%COUNTER1_URL%"
  set "BADIZO_API_HEALTH_URL=http://%SERVER_HOST%:5000/api/health"
  start "" "%BADIZO_EXE_PROGRAMFILES%" --force-device-scale-factor=0.85
) else if exist "%BADIZO_EXE_PROGRAMFILES_X86%" (
  set "BADIZO_APP_URL=%COUNTER1_URL%"
  set "BADIZO_API_HEALTH_URL=http://%SERVER_HOST%:5000/api/health"
  start "" "%BADIZO_EXE_PROGRAMFILES_X86%" --force-device-scale-factor=0.85
) else (
  echo Badizo app install not found. Opening in browser...
  start "" "%COUNTER1_URL%"
)

echo.
pause
exit /b 0

:write_config
if exist "%~1" copy /Y "%~1" "%~1.backup" >nul 2>nul
> "%~1" echo {
>> "%~1" echo   "appUrl": "http://%SERVER_HOST%:3000?loginMode=counter^&loginUser=counter1",
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

:write_launcher
> "%~1" echo @echo off
>> "%~1" echo set "SERVER_HOST=%SERVER_HOST%"
>> "%~1" echo set "BADIZO_APP_URL=http://%%SERVER_HOST%%:3000?loginMode=counter^&loginUser=counter1"
>> "%~1" echo set "BADIZO_API_HEALTH_URL=http://%%SERVER_HOST%%:5000/api/health"
>> "%~1" echo if exist "%%LOCALAPPDATA%%\Programs\Badizo\Badizo.exe" start "" "%%LOCALAPPDATA%%\Programs\Badizo\Badizo.exe" --force-device-scale-factor=0.85 ^& exit /b
>> "%~1" echo if exist "%%ProgramFiles%%\Badizo\Badizo.exe" start "" "%%ProgramFiles%%\Badizo\Badizo.exe" --force-device-scale-factor=0.85 ^& exit /b
>> "%~1" echo if exist "%%ProgramFiles(x86)%%\Badizo\Badizo.exe" start "" "%%ProgramFiles(x86)%%\Badizo\Badizo.exe" --force-device-scale-factor=0.85 ^& exit /b
>> "%~1" echo echo Badizo.exe not found. Opening in browser...
>> "%~1" echo start "" "%%BADIZO_APP_URL%%"
>> "%~1" echo pause
exit /b 0

:write_shortcut
set "BADIZO_SHORTCUT_PATH=%~1"
set "BADIZO_LAUNCHER_CMD=%ROLE_LAUNCHER_CMD%"
set "BADIZO_LAUNCHER_DIR=%ROLE_LAUNCHER_DIR%"
set "BADIZO_ICON_PATH="
if exist "%~dp0badizo.ico" set "BADIZO_ICON_PATH=%~dp0badizo.ico"
if not defined BADIZO_ICON_PATH if exist "%BADIZO_EXE%" set "BADIZO_ICON_PATH=%BADIZO_EXE%"
if not defined BADIZO_ICON_PATH if exist "%BADIZO_EXE_PROGRAMFILES%" set "BADIZO_ICON_PATH=%BADIZO_EXE_PROGRAMFILES%"
if not defined BADIZO_ICON_PATH if exist "%BADIZO_EXE_PROGRAMFILES_X86%" set "BADIZO_ICON_PATH=%BADIZO_EXE_PROGRAMFILES_X86%"
powershell -NoProfile -ExecutionPolicy Bypass -Command "$shortcut=(New-Object -ComObject WScript.Shell).CreateShortcut($env:BADIZO_SHORTCUT_PATH); $shortcut.TargetPath=$env:BADIZO_LAUNCHER_CMD; $shortcut.WorkingDirectory=$env:BADIZO_LAUNCHER_DIR; if ($env:BADIZO_ICON_PATH) { $shortcut.IconLocation=$env:BADIZO_ICON_PATH }; $shortcut.Save()"
exit /b 0

endlocal
