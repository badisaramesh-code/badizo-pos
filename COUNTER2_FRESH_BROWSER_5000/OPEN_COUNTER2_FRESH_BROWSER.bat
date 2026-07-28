@echo off
setlocal

set "BADIZO_URL=http://192.168.1.9:5000?loginMode=counter&loginUser=counter2&v=%RANDOM%%RANDOM%"
set "PROFILE_DIR=%LOCALAPPDATA%\BadizoCounter2ChromeProfile"

if exist "%ProgramFiles%\Google\Chrome\Application\chrome.exe" (
  start "" "%ProgramFiles%\Google\Chrome\Application\chrome.exe" --user-data-dir="%PROFILE_DIR%" --no-first-run --disable-background-networking --disable-features=Translate --app="%BADIZO_URL%"
  exit /b
)

if exist "%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe" (
  start "" "%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe" --user-data-dir="%PROFILE_DIR%" --no-first-run --disable-background-networking --disable-features=Translate --app="%BADIZO_URL%"
  exit /b
)

start "" "%BADIZO_URL%"
