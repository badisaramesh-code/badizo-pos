@echo off
setlocal
title Badizo Shortcut Fix
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0fix-badizo-shortcut-one-click.ps1"
if errorlevel 1 (
  echo.
  echo Shortcut fix failed. Run this file as administrator.
  pause
  exit /b 1
)
echo.
echo Badizo shortcut is ready.
pause
endlocal
