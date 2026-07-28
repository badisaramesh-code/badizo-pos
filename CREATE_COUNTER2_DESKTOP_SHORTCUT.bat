@echo off
setlocal

set "SHORTCUT=%USERPROFILE%\Desktop\Badizo Counter2.url"

echo [InternetShortcut]>"%SHORTCUT%"
echo URL=http://192.168.1.8:5000?loginMode=counter^&loginUser=counter2>>"%SHORTCUT%"
echo IconFile=%SystemRoot%\System32\SHELL32.dll>>"%SHORTCUT%"
echo IconIndex=220>>"%SHORTCUT%"

echo.
echo Created desktop shortcut:
echo %SHORTCUT%
echo.
echo Double-click "Badizo Counter2" on the Desktop.
pause

endlocal
