@echo off
setlocal

set "APP_ROOT=%~dp0"
set "SERVER_IP=192.168.1.16"
set "NODE_EXE=C:\Program Files\nodejs\node.exe"

title Restart Badizo Server 5000

echo Restarting Badizo server for port 5000 frontend...
echo.

if not exist "%NODE_EXE%" (
  for /f "delims=" %%I in ('where node.exe 2^>nul') do (
    set "NODE_EXE=%%I"
    goto :node_found
  )
)

:node_found
if not exist "%NODE_EXE%" (
  echo Node.js was not found.
  pause
  exit /b 1
)

echo Stopping old Badizo port 3000/5000 processes...
for /f "tokens=5" %%P in ('netstat -ano ^| findstr ":3000 :5000" ^| findstr "LISTENING"') do (
  taskkill /PID %%P /F >nul 2>nul
)

timeout /t 2 /nobreak >nul

echo Starting Badizo backend + frontend on port 5000...
start "Badizo Server 5000" /min /D "%APP_ROOT%backend" "%NODE_EXE%" server.js

timeout /t 4 /nobreak >nul

echo.
echo Test on this server:
echo http://localhost:5000
echo.
echo Test on admin/counter systems:
echo http://%SERVER_IP%:5000
echo.
start "" "http://localhost:5000"
pause
