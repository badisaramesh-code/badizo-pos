@echo off
setlocal

set "SCRIPT_DIR=%~dp0"
set "SERVER_IP=192.168.1.7"
set "UPDATE_PS1=%SCRIPT_DIR%apply-shop-update-one-click.ps1"

if not exist "%UPDATE_PS1%" (
  set "UPDATE_PS1=%SCRIPT_DIR%scripts\windows\apply-shop-update-one-click.ps1"
)

powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "Start-Process -Verb RunAs -FilePath powershell.exe -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File','\"%UPDATE_PS1%\"','-ServerIp','%SERVER_IP%'"

endlocal
