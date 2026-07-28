@echo off
setlocal

set "SCRIPT_DIR=%~dp0"
set "SERVER_IP=192.168.1.8"
set "SETUP_PS1=%SCRIPT_DIR%setup-slave-app.ps1"

if not exist "%SETUP_PS1%" (
  echo Missing setup script: %SETUP_PS1%
  echo Extract the full zip first, then run this bat from the extracted folder.
  pause
  exit /b 1
)

if not exist "%SCRIPT_DIR%Badizo Setup 1.0.0.exe" (
  echo Missing installer: %SCRIPT_DIR%Badizo Setup 1.0.0.exe
  echo Extract the full zip first, then run this bat from the extracted folder.
  pause
  exit /b 1
)

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%SETUP_PS1%" -ServerIp "%SERVER_IP%" -LoginMode counter -LoginUser counter2

echo.
pause

endlocal
