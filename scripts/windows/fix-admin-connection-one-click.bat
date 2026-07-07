@echo off
setlocal

set "SERVER_HOST=192.168.1.9"
set "LOGIN_MODE=admin"

echo Updating Badizo admin connection...
echo Server: http://%SERVER_HOST%:3000
echo.

powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "$configDir = Join-Path $env:APPDATA 'Badizo'; New-Item -ItemType Directory -Force -Path $configDir | Out-Null; $config = [ordered]@{ appUrl = 'http://%SERVER_HOST%:3000'; apiHealthUrl = 'http://%SERVER_HOST%:5000/api/health'; backendPort = 5000; frontendPort = 3000; startBackend = $false; startFrontend = $false; loginMode = '%LOGIN_MODE%'; kiosk = $false; devTools = $false }; $config | ConvertTo-Json -Depth 4 | Set-Content -Path (Join-Path $configDir 'app-config.json') -Encoding UTF8; Write-Host 'Badizo admin config updated:' (Join-Path $configDir 'app-config.json') -ForegroundColor Green"

echo.
echo Done. Close Badizo and open it again.
pause

endlocal
