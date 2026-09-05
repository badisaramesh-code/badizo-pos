@echo off
setlocal
title Badizo LAN Check
set "SERVER=192.168.1.10"
echo Checking Badizo server %SERVER%...
powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "$h=Test-NetConnection -ComputerName '%SERVER%' -Port 5000 -InformationLevel Quiet; if($h){Write-Host 'PASS: Badizo server port 5000 reachable' -ForegroundColor Green}else{Write-Host 'FAIL: Check server power, LAN cable, IP conflict, and firewall.' -ForegroundColor Red}; try{$r=Invoke-WebRequest -UseBasicParsing -Uri 'http://%SERVER%:5000/api/health' -TimeoutSec 5; Write-Host ('PASS: API health HTTP '+$r.StatusCode) -ForegroundColor Green}catch{Write-Host ('FAIL: API health '+$_.Exception.Message) -ForegroundColor Red}"
echo.
echo Browser is only for optional checking: http://%SERVER%:5000/api/health
pause
endlocal