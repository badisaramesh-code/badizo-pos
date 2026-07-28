@echo off
setlocal
title Admin1 TSC Printer Network Access Fix
net session >nul 2>nul
if not "%errorlevel%"=="0" (
  powershell.exe -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
  exit /b
)
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0admin1-printer-access.ps1"
echo.
pause
