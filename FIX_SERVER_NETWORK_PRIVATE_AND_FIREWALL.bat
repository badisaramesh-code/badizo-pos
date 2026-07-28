@echo off
setlocal

title Badizo Server Network + Firewall Fix

echo Badizo Server Network + Firewall Fix
echo This fixes common Windows Public network / firewall blocking for Badizo.
echo.

net session >nul 2>&1
if errorlevel 1 (
  echo Please right-click this file and choose Run as administrator.
  echo.
  pause
  exit /b 1
)

echo Setting active network profile to Private...
powershell -NoProfile -ExecutionPolicy Bypass -Command "Get-NetConnectionProfile | Where-Object { $_.IPv4Connectivity -ne 'Disconnected' -or $_.IPv6Connectivity -ne 'Disconnected' } | Set-NetConnectionProfile -NetworkCategory Private" >nul 2>nul

echo Enabling local firewall rules for current profile...
netsh advfirewall set currentprofile settings localfirewallrules enable >nul

echo Adding Badizo port rules...
netsh advfirewall firewall delete rule name="Badizo POS Frontend 3000" >nul 2>nul
netsh advfirewall firewall delete rule name="Badizo POS Backend 5000" >nul 2>nul
netsh advfirewall firewall add rule name="Badizo POS Frontend 3000" dir=in action=allow protocol=TCP localport=3000 profile=private >nul
netsh advfirewall firewall add rule name="Badizo POS Backend 5000" dir=in action=allow protocol=TCP localport=5000 profile=private >nul

echo.
echo Current server IP:
ipconfig | findstr /i "IPv4"
echo.
echo Badizo ports:
netstat -ano | findstr ":3000 :5000"
echo.
echo Done. Now test this URL on admin/counter systems:
echo http://192.168.1.9:3000
echo.
pause
