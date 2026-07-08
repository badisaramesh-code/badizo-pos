@echo off
setlocal

set "SCRIPT_DIR=%~dp0"
set "FIX_PS1=%SCRIPT_DIR%fix-server-distribution-5000-one-click.ps1"

if not exist "%FIX_PS1%" (
  echo Missing %FIX_PS1%
  pause
  exit /b 1
)

powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "Start-Process powershell.exe -Verb RunAs -ArgumentList '-NoProfile -ExecutionPolicy Bypass -File ""%FIX_PS1%""'"

endlocal
