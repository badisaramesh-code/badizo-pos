@echo off
setlocal

set "SERVER_HOST=192.168.1.9"
set "LOGIN_USER=counter2"
set "BADIZO_APP_URL=http://%SERVER_HOST%:5000?loginMode=counter&loginUser=%LOGIN_USER%"
set "BADIZO_API_HEALTH_URL=http://%SERVER_HOST%:5000/api/health"
set "BADIZO_SERVER_HOSTS=%SERVER_HOST%,badizo-server.local,badizo-server,server"

echo Opening Badizo Counter2...
echo %BADIZO_APP_URL%
echo.

set "BADIZO_EXE="
if exist "%LOCALAPPDATA%\Programs\Badizo\Badizo.exe" set "BADIZO_EXE=%LOCALAPPDATA%\Programs\Badizo\Badizo.exe"
if not defined BADIZO_EXE if exist "%ProgramFiles%\Badizo\Badizo.exe" set "BADIZO_EXE=%ProgramFiles%\Badizo\Badizo.exe"
if not defined BADIZO_EXE if exist "C:\Program Files (x86)\Badizo\Badizo.exe" set "BADIZO_EXE=C:\Program Files (x86)\Badizo\Badizo.exe"

if defined BADIZO_EXE (
  start "" "%BADIZO_EXE%"
  exit /b 0
)

echo Badizo.exe not found. Opening browser fallback.
start "" "%BADIZO_APP_URL%"
