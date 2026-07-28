@echo off
setlocal

set "PROFILE_DIR=%LOCALAPPDATA%\BadizoCounter2ChromeProfile"

taskkill /IM chrome.exe /F >nul 2>nul
if exist "%PROFILE_DIR%" rmdir /S /Q "%PROFILE_DIR%"

call "%~dp0OPEN_COUNTER2_FRESH_BROWSER.bat"
