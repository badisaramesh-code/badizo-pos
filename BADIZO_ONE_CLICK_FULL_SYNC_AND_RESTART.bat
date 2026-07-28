@echo off
setlocal

set "BADIZO_ROOT=D:\badizo-pos-main"
set "BADIZO_SCRIPT=%BADIZO_ROOT%\BADIZO_ONE_CLICK_FULL_SYNC_AND_RESTART.ps1"

if /I not "%~dp0"=="%BADIZO_ROOT%\" (
  echo BADIZO NOT READY - REVIEW REQUIRED
  echo This launcher must remain in %BADIZO_ROOT%.
  pause
  exit /b 1
)

if not exist "%BADIZO_SCRIPT%" (
  echo BADIZO NOT READY - REVIEW REQUIRED
  echo Missing: %BADIZO_SCRIPT%
  pause
  exit /b 1
)

net session >nul 2>&1
if errorlevel 1 (
  powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "Start-Process powershell.exe -Verb RunAs -WorkingDirectory '%BADIZO_ROOT%' -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File','%BADIZO_SCRIPT%'"
  if errorlevel 1 (
    echo BADIZO NOT READY - REVIEW REQUIRED
    echo Administrator approval was not granted.
    pause
    exit /b 1
  )
  exit /b 0
)

cd /d "%BADIZO_ROOT%"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%BADIZO_SCRIPT%"
exit /b %errorlevel%

