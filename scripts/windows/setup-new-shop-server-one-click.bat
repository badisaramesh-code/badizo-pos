@echo off
setlocal

set "SCRIPT_DIR=%~dp0"
set "SERVER_IP=192.168.1.9"
set "SETUP_PS1=%SCRIPT_DIR%setup-new-shop-server-one-click.ps1"
set "BADIZO_SKIP_OPEN_AFTER_BUILD=1"

if not exist "%SETUP_PS1%" (
  set "SETUP_PS1=%SCRIPT_DIR%scripts\windows\setup-new-shop-server-one-click.ps1"
)

powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "Start-Process -Verb RunAs -FilePath powershell.exe -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File','\"%SETUP_PS1%\"','-ServerIp','%SERVER_IP%'"

endlocal
