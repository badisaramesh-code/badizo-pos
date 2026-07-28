@echo off
setlocal
set "BADIZO_PATH=?loginMode=counter^&loginUser=counter3"

for %%H in (badizo-server.local badizo-server 192.168.1.10 localhost) do (
  powershell -NoProfile -Command "try { $r = Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 'http://%%H:5000/api/health'; if ($r.StatusCode -eq 200) { exit 0 } } catch {}; exit 1" >nul 2>&1
  if not errorlevel 1 (
    start "Badizo System 3" "http://%%H:5000/%BADIZO_PATH%"
    exit /b 0
  )
)

echo Badizo server was not found. Check that the server PC is on and connected to this network.
pause
exit /b 1
