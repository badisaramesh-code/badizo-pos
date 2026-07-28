@echo off
setlocal
title Apply Badizo Admin1 33x25 Printer Fix

net session >nul 2>nul
if not "%errorlevel%"=="0" (
  echo Requesting Administrator permission...
  powershell.exe -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
  exit /b
)

echo Stopping old Badizo server on ports 3000 and 5000...
powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "$processIds = Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object { $_.LocalPort -in 3000,5000 } | Select-Object -ExpandProperty OwningProcess -Unique; foreach ($processId in $processIds) { Stop-Process -Id $processId -Force -ErrorAction SilentlyContinue }"
timeout /t 2 /nobreak >nul

echo Starting corrected Badizo server...
powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "Start-Process -FilePath 'C:\Program Files\nodejs\node.exe' -ArgumentList 'server.js' -WorkingDirectory '%~dp0backend' -WindowStyle Hidden"

echo Waiting for server...
powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "$ok=$false; for($i=0;$i -lt 40;$i++){ Start-Sleep -Milliseconds 500; try { $r=Invoke-WebRequest -UseBasicParsing -Uri 'http://localhost:5000/api/health' -TimeoutSec 2; if($r.StatusCode -eq 200){$ok=$true;break} } catch {} }; if(!$ok){exit 1}"
if errorlevel 1 (
  echo ERROR: Server did not restart. Check backend logs.
  pause
  exit /b 1
)

echo.
echo SUCCESS: Server is using Admin1 printer path:
echo \\192.168.1.7\TSC-244-2
echo.
echo Now try Print Barcode Labels once from Admin1.
pause
