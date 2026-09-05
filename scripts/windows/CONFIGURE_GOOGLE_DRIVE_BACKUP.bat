@echo off
setlocal
title Badizo - Configure Google Drive Backup
powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "Start-Process -Verb RunAs -FilePath powershell.exe -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File','%~dp0payload\configure-google-drive-backup.ps1'"
endlocal