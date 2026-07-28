@echo off
setlocal

title Badizo Server Firewall Fix

echo Badizo Server Firewall Fix
echo This opens Badizo ports 3000 and 5000 for counter/admin systems.
echo.

net session >nul 2>&1
if errorlevel 1 (
  echo Please right-click this file and choose Run as administrator.
  echo.
  pause
  exit /b 1
)

netsh advfirewall firewall delete rule name="Badizo POS Frontend 3000" >nul 2>nul
netsh advfirewall firewall delete rule name="Badizo POS Backend 5000" >nul 2>nul
netsh advfirewall firewall add rule name="Badizo POS Frontend 3000" dir=in action=allow protocol=TCP localport=3000 profile=private >nul
netsh advfirewall firewall add rule name="Badizo POS Backend 5000" dir=in action=allow protocol=TCP localport=5000 profile=private >nul

echo Firewall rules added:
echo - Badizo POS Frontend 3000
echo - Badizo POS Backend 5000
echo.
echo Now open this URL on admin/counter systems:
echo http://192.168.1.9:3000
echo.
pause
