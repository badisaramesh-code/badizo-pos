@echo off
setlocal EnableExtensions
title Badizo POS - New Store Installer
cd /d "%~dp0"

if not exist "%~dp0payload\install-new-store.ps1" (
  echo ERROR: payload\install-new-store.ps1 is missing.
  echo Copy the complete BADIZO_NEW_STORE_OFFLINE_PACKAGE folder to this computer.
  pause
  exit /b 1
)

echo.
echo ============================================================
echo          BADIZO POS - NEW STORE OFFLINE INSTALLER
echo ============================================================
echo   1. SERVER PC
echo   2. COUNTER PC
echo   3. ADMIN PC
echo   4. SECURITY PC
echo   5. Exit
echo.
set /p "BADIZO_CHOICE=Select this computer type [1-5]: "

if "%BADIZO_CHOICE%"=="1" goto server
if "%BADIZO_CHOICE%"=="2" goto counter
if "%BADIZO_CHOICE%"=="3" goto admin
if "%BADIZO_CHOICE%"=="4" goto security
if "%BADIZO_CHOICE%"=="5" exit /b 0
echo Invalid selection.
pause
exit /b 1

:server
powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "Start-Process -Verb RunAs -FilePath powershell.exe -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File','\"%~dp0payload\install-new-store.ps1\"','-PackageRoot','\"%~dp0\"'"
exit /b 0

:counter
set "BADIZO_ROLE=counter"
goto client
:admin
set "BADIZO_ROLE=admin"
goto client
:security
set "BADIZO_ROLE=security"
goto client

:client
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0payload\setup-slave-app.ps1" -ServerIp "192.168.1.10" -LoginMode "%BADIZO_ROLE%" -InstallerPath "%~dp0payload\Badizo Setup 1.0.0.exe"
echo.
pause
exit /b %ERRORLEVEL%
