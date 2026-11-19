@echo off
setlocal
set "SCRIPT=%~dp0scripts\windows\deploy-local-ledger-delete.ps1"
powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "Start-Process powershell.exe -Verb RunAs -Wait -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-File','%SCRIPT%')"
if errorlevel 1 (
  echo Deployment did not complete. Check the PowerShell message above.
  pause
  exit /b 1
)
echo.
echo Local/Non-Local ledger delete update completed.
pause
