@echo off
setlocal
title Connect Server to Admin1 TSC Printer
net session >nul 2>nul
if not "%errorlevel%"=="0" (
  powershell.exe -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
  exit /b
)

echo Removing old/wrong Windows connection to Admin1...
net use \\192.168.1.7\IPC$ /delete /y >nul 2>nul
net use \\192.168.1.7 /delete /y >nul 2>nul

echo Saving correct Admin1 printer credentials...
cmdkey /delete:192.168.1.7 >nul 2>nul
cmdkey /add:192.168.1.7 /user:192.168.1.7\badizo-printer /pass:BadizoPrint#244
net use \\192.168.1.7\IPC$ /user:192.168.1.7\badizo-printer BadizoPrint#244 /persistent:yes
if errorlevel 1 (
  echo.
  echo ERROR: Server could not authenticate to Admin1.
  echo Run the Admin1 network access fix first, then run this file again.
  pause
  exit /b 1
)

echo.
echo SUCCESS: Server is connected to \\192.168.1.7\TSC-244-2
echo Go to Admin1 and press Print Barcode Labels.
pause
