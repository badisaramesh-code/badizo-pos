@echo off
setlocal

set "SCRIPT_DIR=%~dp0"
set "SERVER_IP=192.168.1.8"
set "SETUP_PS1=%SCRIPT_DIR%setup-slave-app.ps1"

if not exist "%SETUP_PS1%" (
  echo Missing setup script: %SETUP_PS1%
  echo Keep setup-counter2-one-click.bat, setup-slave-app.ps1, and Badizo Setup 1.0.0.exe in the same folder.
  echo.
  echo If this path shows AppData\Local\Temp\Rar$, close this window and extract the full zip first.
  echo Right-click badizo-counter2-192.168.1.8-install.zip, choose Extract All, then run this file from the extracted folder.
  pause
  exit /b 1
)

if not exist "%SCRIPT_DIR%Badizo Setup 1.0.0.exe" (
  echo Missing installer: %SCRIPT_DIR%Badizo Setup 1.0.0.exe
  echo Keep setup-counter2-one-click.bat, setup-slave-app.ps1, and Badizo Setup 1.0.0.exe in the same folder.
  echo.
  echo If this path shows AppData\Local\Temp\Rar$, close this window and extract the full zip first.
  echo Right-click badizo-counter2-192.168.1.8-install.zip, choose Extract All, then run this file from the extracted folder.
  pause
  exit /b 1
)

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%SETUP_PS1%" -ServerIp "%SERVER_IP%" -LoginMode counter

echo.
pause

endlocal
