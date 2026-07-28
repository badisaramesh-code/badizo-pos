@echo off
setlocal

set "SHORTCUT=%USERPROFILE%\Desktop\Badizo Counter1.url"

echo [InternetShortcut]>"%SHORTCUT%"
echo URL=http://192.168.1.9:5000?loginMode=counter^&loginUser=counter1>>"%SHORTCUT%"
echo IconFile=%SystemRoot%\System32\SHELL32.dll>>"%SHORTCUT%"
echo IconIndex=220>>"%SHORTCUT%"

echo.
echo Created desktop shortcut:
echo %SHORTCUT%
echo.
echo Double-click "Badizo Counter1" on the Desktop.
pause

endlocal
