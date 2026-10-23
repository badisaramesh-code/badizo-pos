@echo off
setlocal
title BADIZO Desktop - Barcode Stickers
rem Barcode printing requires the Electron desktop bridge, unavailable in Edge app mode.
set "BADIZO_DESKTOP=%LOCALAPPDATA%\Programs\Badizo\Badizo.exe"
if not exist "%BADIZO_DESKTOP%" (
    echo BADIZO Desktop was not found. Install the BADIZO desktop application first.
    pause
    exit /b 1
)
start "" "%BADIZO_DESKTOP%"
endlocal
