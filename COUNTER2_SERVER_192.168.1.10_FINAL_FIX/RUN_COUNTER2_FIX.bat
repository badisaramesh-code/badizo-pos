@echo off
setlocal
title Badizo Counter2 Server 192.168.1.10 Fix
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0fix-counter2.ps1"
echo.
pause
