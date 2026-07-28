@echo off
setlocal
title Badizo Admin1 Permanent Network Fix

net session >nul 2>&1
if errorlevel 1 (
  echo.
  echo ERROR: Right-click this file and choose Run as administrator.
  echo.
  pause
  exit /b 1
)

echo Setting Admin1 Ethernet IP to 192.168.1.7...
netsh interface ipv4 set address name="Ethernet" source=static address=192.168.1.7 mask=255.255.255.0 gateway=192.168.1.1 store=persistent
if errorlevel 1 goto :failed

netsh interface ipv4 set dnsservers name="Ethernet" source=static address=192.168.1.1 validate=no
if errorlevel 1 goto :failed

echo Enabling printer sharing for the Badizo server...
netsh advfirewall firewall add rule name="Badizo Server Printer Access" dir=in action=allow protocol=TCP localport=445 remoteip=192.168.1.10 profile=any >nul

echo.
echo SUCCESS: Admin1 is now configured as 192.168.1.7
echo Restart this PC, then test barcode printing from Badizo.
echo.
ipconfig | findstr /i /c:"IPv4 Address" /c:"Subnet Mask" /c:"Default Gateway"
pause
exit /b 0

:failed
echo.
echo FAILED: Could not configure Ethernet. Confirm the cable adapter is named Ethernet.
echo.
pause
exit /b 1
