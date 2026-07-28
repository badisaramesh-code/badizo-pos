@echo off
setlocal
title Badizo Admin1 33x25 TSC TE244 Setup

net session >nul 2>nul
if not "%errorlevel%"=="0" (
  echo Requesting Administrator permission...
  powershell.exe -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
  exit /b
)

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0setup-admin1-33x25.ps1"
set "RESULT=%errorlevel%"
echo.
if "%RESULT%"=="0" (
  echo ADMIN1 SETUP COMPLETED SUCCESSFULLY.
) else (
  echo ADMIN1 SETUP FAILED. Read the red message above.
)
pause
exit /b %RESULT%
