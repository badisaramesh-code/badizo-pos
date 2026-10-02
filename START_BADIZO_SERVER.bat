@echo off
setlocal
title Badizo Server
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\windows\start-installed-service.ps1"
set "BADIZO_RESULT=%ERRORLEVEL%"
echo.
pause
exit /b %BADIZO_RESULT%