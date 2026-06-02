@echo off
setlocal

set "PRINTER_SHARE=\\localhost\TSC 244-1"

if "%~1"=="" (
  echo Usage: print-33x25-to-tsc-244-1.bat output\your-file.prn
  echo Windows shared printer name expected: TSC 244-1
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
