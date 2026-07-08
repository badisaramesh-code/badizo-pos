@echo off
setlocal

set "SCRIPT_DIR=%~dp0"
set "FIX_PS1=%SCRIPT_DIR%fix-counter2-permanent-lan.ps1"

if not exist "%FIX_PS1%" (
  echo Missing fix script: %FIX_PS1%
  echo Keep this BAT, fix-counter2-permanent-lan.ps1, and Badizo Setup 1.0.0.exe in the same folder.
  pause
  exit /b 1
)

if not exist "%SCRIPT_DIR%Badizo Setup 1.0.0.exe" (
  echo Missing installer: %SCRIPT_DIR%Badizo Setup 1.0.0.exe
  echo Keep Badizo Setup 1.0.0.exe in this same folder.
  pause
  exit /b 1
)

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%FIX_PS1%"

echo.
pause

endlocal
