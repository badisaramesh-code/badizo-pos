@echo off
setlocal

set "SCRIPT_DIR=%~dp0"
set "SERVER_HOST=192.168.1.9"
set "CHECK_PS1=%SCRIPT_DIR%check-lan-connection.ps1"

if not exist "%CHECK_PS1%" (
  echo Missing check script: %CHECK_PS1%
  pause
  exit /b 1
)

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%CHECK_PS1%" -ServerHost "%SERVER_HOST%" -Count 20 -DelaySeconds 2

echo.
pause

endlocal
