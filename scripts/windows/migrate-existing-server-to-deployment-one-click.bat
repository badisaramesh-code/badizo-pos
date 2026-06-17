@echo off
setlocal

set "SCRIPT_DIR=%~dp0"
set "SERVER_IP=192.168.1.12"
set "TARGET_ROOT=C:\BadizoServer"
set "MIGRATE_PS1=%SCRIPT_DIR%migrate-existing-server-to-deployment-one-click.ps1"

powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "Start-Process -Verb RunAs -FilePath powershell.exe -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File','\"%MIGRATE_PS1%\"','-ServerIp','%SERVER_IP%','-TargetRoot','\"%TARGET_ROOT%\"'"

endlocal
