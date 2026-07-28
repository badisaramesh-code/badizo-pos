@echo off
setlocal

set "SCRIPT_DIR=%~dp0"
set "FIX_PS1=%SCRIPT_DIR%counter2-desktop-pos-ready.ps1"

if not exist "%FIX_PS1%" (
  echo Missing file: %FIX_PS1%
  pause
  exit /b 1
)

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%FIX_PS1%"

echo.
pause
endlocal
