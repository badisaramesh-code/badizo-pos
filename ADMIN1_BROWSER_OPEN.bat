@echo off
setlocal

set "ADMIN_URL=http://192.168.1.9:3000?loginMode=admin&loginUser=admin1"

title Badizo Admin1 Browser Open

echo Opening Badizo Admin1 in browser...
echo %ADMIN_URL%
echo.

start "" "%ADMIN_URL%"

echo If browser also cannot open, run CHECK_BADIZO_ADMIN_CONNECTION.bat and send photo.
pause
