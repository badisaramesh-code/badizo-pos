@echo off
setlocal
title Badizo Admin1 Printer SMB Fix - 2026-07-16
net session >nul 2>nul
if not "%errorlevel%"=="0" (
  powershell.exe -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
  exit /b
)
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0admin1-printer-smb-fix.ps1"
echo.
pause
