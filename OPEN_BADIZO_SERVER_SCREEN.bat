@echo off
setlocal

set "APP_ROOT=%~dp0"
set "BADIZO_URL=http://192.168.1.10:5000"

rem Start/restart the server in its own minimized window, then show the POS screen.
start "Badizo Server" /min "%APP_ROOT%START_BADIZO_SERVER.bat"
timeout /t 3 /nobreak >nul
start "" "%BADIZO_URL%"

endlocal
