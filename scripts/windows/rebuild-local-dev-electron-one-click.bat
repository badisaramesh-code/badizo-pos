@echo off
setlocal
cd /d "%~dp0"
echo Badizo local development rebuild/restart with Electron
echo.
echo This uses your local code exactly as-is. No git pull is performed.
echo.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0rebuild-local-dev-one-click.ps1" -OpenElectron
echo.
pause
