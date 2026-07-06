@echo off
setlocal

set "SCRIPT_DIR=%~dp0"
set "SERVER_IP=192.168.1.9"
set "UPDATE_PS1=%SCRIPT_DIR%update-badizo-app.ps1"

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%UPDATE_PS1%" -ServerIp "%SERVER_IP%"

endlocal
