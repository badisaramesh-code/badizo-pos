@echo off
setlocal

net session >nul 2>&1
if errorlevel 1 (
  echo Requesting administrator permission...
  powershell -NoProfile -ExecutionPolicy Bypass -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
  exit /b
)

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0setup-server-lan-only.ps1"
if errorlevel 1 (
  echo.
  echo SERVER SETUP FAILED. Read the red error above.
  pause
  exit /b 1
)

echo.
echo SERVER LAN-ONLY SETUP COMPLETED.
echo Badizo URL: http://192.168.1.10:5000
pause

