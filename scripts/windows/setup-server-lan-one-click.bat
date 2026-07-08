@echo off
setlocal

set "SCRIPT_DIR=%~dp0"
set "SETUP_PS1=%SCRIPT_DIR%setup-server-lan-one-click.ps1"
set "BADIZO_SKIP_OPEN_AFTER_BUILD=1"

if not exist "%SETUP_PS1%" (
  echo Missing setup script: %SETUP_PS1%
  echo Run this BAT from the scripts\windows folder or copy the complete deployment package.
  pause
  exit /b 1
)

powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "Start-Process -Verb RunAs -FilePath powershell.exe -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File','\"%SETUP_PS1%\"'"

endlocal
