@echo off
setlocal

set "SCRIPT_DIR=%~dp0"
set "SERVER_IP=192.168.1.12"

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT_DIR%setup-slave-app.ps1" -ServerIp "%SERVER_IP%"

echo.
pause

endlocal
