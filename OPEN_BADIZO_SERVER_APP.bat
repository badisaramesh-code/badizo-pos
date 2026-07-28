@echo off
setlocal

set "BADIZO_EXE=%LOCALAPPDATA%\Programs\Badizo\Badizo.exe"
set "BADIZO_APP_URL=http://localhost:5000?loginMode=all"
set "BADIZO_API_HEALTH_URL=http://localhost:5000/api/health"
set "BADIZO_SERVER_HOSTS=localhost,192.168.1.10,badizo-server.local,badizo-server,server"
set "BADIZO_LOGIN_MODE=all"
set "BADIZO_LOGIN_USER="

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\windows\set-badizo-server-app-config.ps1"
if errorlevel 1 (
  echo Unable to set Badizo Server app configuration.
  pause
  exit /b 1
)

if not exist "%BADIZO_EXE%" (
  echo Badizo desktop app was not found:
  echo %BADIZO_EXE%
  pause
  exit /b 1
)

taskkill /IM Badizo.exe /F >nul 2>&1
start "" "%BADIZO_EXE%"

endlocal
