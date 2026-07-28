@echo off
setlocal

set "BADIZO_URL=http://192.168.1.9:5000?loginMode=counter&loginUser=counter2"

if exist "%ProgramFiles%\Google\Chrome\Application\chrome.exe" (
  start "" "%ProgramFiles%\Google\Chrome\Application\chrome.exe" --app="%BADIZO_URL%"
  exit /b
)

if exist "%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe" (
  start "" "%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe" --app="%BADIZO_URL%"
  exit /b
)

start "" "%BADIZO_URL%"
