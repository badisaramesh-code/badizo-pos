@echo off
setlocal

set "APP_ROOT=%~dp0"
set "SERVER_IP=192.168.1.16"

echo Starting Badizo POS server...
echo.

set "NODE_EXE=C:\Program Files\nodejs\node.exe"
if not exist "%NODE_EXE%" (
  for /f "delims=" %%I in ('where node.exe 2^>nul') do (
    set "NODE_EXE=%%I"
    goto :node_found
  )
)

:node_found
if not exist "%NODE_EXE%" (
  echo.
  echo Node.js was not found in PATH. Install Node.js or restart this computer after installing it.
  pause
  exit /b 1
)

start "Badizo Backend Server" /min /D "%APP_ROOT%backend" "%NODE_EXE%" server.js
start "Badizo Frontend Server" /min /D "%APP_ROOT%" "%NODE_EXE%" scripts\windows\serve-frontend-build.js

echo.
echo Badizo POS server start command completed.
echo Frontend: http://%SERVER_IP%:3000
echo Backend:  http://%SERVER_IP%:5000/api/health
echo.

timeout /t 3 /nobreak >nul
start "" "http://%SERVER_IP%:3000"

pause

endlocal
