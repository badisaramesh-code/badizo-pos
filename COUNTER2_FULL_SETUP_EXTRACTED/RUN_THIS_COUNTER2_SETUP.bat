@echo off
setlocal

set "SCRIPT_DIR=%~dp0"
set "SERVER_IP=192.168.1.8"
set "SETUP_PS1=%SCRIPT_DIR%setup-slave-app.ps1"

if not exist "%SETUP_PS1%" (
  echo Missing setup script: %SETUP_PS1%
  echo Keep setup-counter2-one-click.bat, setup-slave-app.ps1, and Badizo Setup 1.0.0.exe in the same folder.
  echo.
  echo DO NOT double-click this file inside WinRAR.
  echo You are running from WinRAR temp folder.
  echo.
  echo Close this black window and close WinRAR.
  echo Right-click COUNTER2_FULL_SETUP_EXTRACTED.zip and choose Extract To or Extract All.
  echo Open the extracted COUNTER2_FULL_SETUP_EXTRACTED folder.
  echo Then double-click RUN_THIS_COUNTER2_SETUP.bat from that folder.
  pause
  exit /b 1
)

if not exist "%SCRIPT_DIR%Badizo Setup 1.0.0.exe" (
  echo Missing installer: %SCRIPT_DIR%Badizo Setup 1.0.0.exe
  echo Keep setup-counter2-one-click.bat, setup-slave-app.ps1, and Badizo Setup 1.0.0.exe in the same folder.
  echo.
  echo DO NOT double-click this file inside WinRAR.
  echo You are running from WinRAR temp folder.
  echo.
  echo Close this black window and close WinRAR.
  echo Right-click COUNTER2_FULL_SETUP_EXTRACTED.zip and choose Extract To or Extract All.
  echo Open the extracted COUNTER2_FULL_SETUP_EXTRACTED folder.
  echo Then double-click RUN_THIS_COUNTER2_SETUP.bat from that folder.
  pause
  exit /b 1
)

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%SETUP_PS1%" -ServerIp "%SERVER_IP%" -LoginMode counter

echo.
pause

endlocal
