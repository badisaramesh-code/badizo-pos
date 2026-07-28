@echo off
setlocal

set "SCRIPT_DIR=%~dp0"

echo.
echo Badizo Counter1 server connection fix
echo Server: 192.168.1.9:5000
echo Login: counter1
echo.

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT_DIR%fix-counter1-to-server-192-168-1-9.ps1"

echo.
echo If the fix completed successfully, open "Badizo Counter1" from the Desktop.
echo.
pause

endlocal
