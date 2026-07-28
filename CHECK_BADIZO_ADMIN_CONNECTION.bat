@echo off
setlocal

set "SERVER_IP=192.168.1.9"

title Badizo Admin Connection Check

echo Badizo Admin Connection Check
echo Server IP: %SERVER_IP%
echo.

echo == Ping server ==
ping -n 2 %SERVER_IP%
echo.

echo == Check Badizo frontend port 3000 ==
powershell -NoProfile -ExecutionPolicy Bypass -Command "Test-NetConnection -ComputerName '%SERVER_IP%' -Port 3000 | Select-Object ComputerName,RemotePort,TcpTestSucceeded"
echo.

echo == Check Badizo backend port 5000 ==
powershell -NoProfile -ExecutionPolicy Bypass -Command "Test-NetConnection -ComputerName '%SERVER_IP%' -Port 5000 | Select-Object ComputerName,RemotePort,TcpTestSucceeded"
echo.

echo Opening browser test URL...
start "" "http://%SERVER_IP%:3000"
echo.
echo Send photo of this window if Badizo still does not open.
pause
