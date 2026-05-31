@echo off
setlocal

set "PRINTER_SHARE=\\localhost\TSC-244-Pro"

if "%~1"=="" (
  echo Usage: print-prn-to-tsc.bat output\your-file.prn
  echo Edit PRINTER_SHARE inside this file if your Windows shared printer name is different.
  exit /b 1
)

if not exist "%~1" (
  echo PRN file not found: %~1
  exit /b 1
)

copy /b "%~1" "%PRINTER_SHARE%"
if errorlevel 1 (
  echo Print failed. Check printer sharing name: %PRINTER_SHARE%
  exit /b 1
)

echo Sent to %PRINTER_SHARE%
