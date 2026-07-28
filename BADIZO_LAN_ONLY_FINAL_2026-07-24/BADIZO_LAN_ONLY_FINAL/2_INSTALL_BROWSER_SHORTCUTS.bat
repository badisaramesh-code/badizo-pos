@echo off
setlocal
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install-browser-shortcuts.ps1"
if errorlevel 1 (
  echo.
  echo SHORTCUT SETUP FAILED. Read the red error above.
  pause
  exit /b 1
)
echo.
echo BADIZO LAN SHORTCUTS ARE READY ON THIS DESKTOP.
pause

