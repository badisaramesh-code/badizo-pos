@echo off
setlocal
title Badizo Counter1 Server 192.168.1.10 Fix
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0fix-counter1.ps1"
echo.
pause
