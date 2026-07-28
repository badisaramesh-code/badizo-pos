@echo off
setlocal

set "URL=http://192.168.1.9:5000?loginMode=counter^&loginUser=counter1"

echo Opening Badizo Counter1 in browser...
echo %URL%
echo.

start "" "%URL%"

echo If Badizo opens correctly, use this file/shortcut for Counter1.
echo Do not use the old Badizo app icon that opens 192.168.1.14:3000.
echo.
pause

endlocal
