@echo off
setlocal

set "SCRIPT=%~dp0scripts\windows\fix-server-static-ip-and-startup.ps1"

if not exist "%SCRIPT%" (
  echo Missing script: %SCRIPT%
  pause
  exit /b 1
)

powershell -NoProfile -ExecutionPolicy Bypass -Command "Start-Process PowerShell -Verb RunAs -ArgumentList '-NoProfile -ExecutionPolicy Bypass -File ""%SCRIPT%"" -TargetIp 192.168.1.14 -InterfaceAlias Ethernet -Gateway 192.168.1.1'"

echo.
echo Admin window opened. Complete the server fix there.
pause

endlocal
