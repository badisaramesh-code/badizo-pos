@echo off
setlocal

set "SHORTCUT=%USERPROFILE%\Desktop\Badizo Counter1 5000.url"

echo [InternetShortcut]>"%SHORTCUT%"
echo URL=http://192.168.1.9:5000?loginMode=counter^&loginUser=counter1>>"%SHORTCUT%"
echo IconFile=%SystemRoot%\System32\SHELL32.dll>>"%SHORTCUT%"
echo IconIndex=220>>"%SHORTCUT%"

echo.
echo Created desktop shortcut:
echo %SHORTCUT%
echo.
echo Open "Badizo Counter1 5000" from Desktop.
echo Do not open the old Badizo icon showing 192.168.1.14:3000.
echo.
pause

endlocal
