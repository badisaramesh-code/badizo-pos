@echo off
setlocal

set "LOGIN_MODE=counter"

echo Updating Badizo client connection...
echo Server: auto-discover on this LAN
echo.

powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "$hosts = @('badizo-server.local','badizo-server','server'); $config = [ordered]@{ appUrl = 'http://badizo-server:5000'; apiHealthUrl = 'http://badizo-server:5000/api/health'; serverHosts = $hosts; discoveryEnabled = $true; discoveryTimeoutMs = 12000; backendPort = 5000; frontendPort = 3000; startBackend = $false; startFrontend = $false; loginMode = '%LOGIN_MODE%'; kiosk = $false; devTools = $false }; foreach ($name in @('Badizo','badizo-desktop')) { $configDir = Join-Path $env:APPDATA $name; New-Item -ItemType Directory -Force -Path $configDir | Out-Null; $config | ConvertTo-Json -Depth 4 | Set-Content -Path (Join-Path $configDir 'app-config.json') -Encoding UTF8; Write-Host 'Badizo client config updated:' (Join-Path $configDir 'app-config.json') -ForegroundColor Green }"

echo.
echo Done. Close Badizo and open it again.
pause

endlocal
