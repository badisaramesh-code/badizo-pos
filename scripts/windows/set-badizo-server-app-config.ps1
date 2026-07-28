$ErrorActionPreference = 'Stop'

$configDir = Join-Path $env:APPDATA 'Badizo'
$configPath = Join-Path $configDir 'app-config.json'
New-Item -ItemType Directory -Path $configDir -Force | Out-Null

$config = [ordered]@{
  appUrl = 'http://localhost:5000?loginMode=all'
  apiHealthUrl = 'http://localhost:5000/api/health'
  serverHosts = @('localhost', '192.168.1.10', 'badizo-server.local', 'badizo-server', 'server')
  discoveryEnabled = $true
  discoveryTimeoutMs = 12000
  backendPort = 5000
  frontendPort = 5000
  startBackend = $false
  startFrontend = $false
  loginMode = 'all'
  loginUser = ''
  kiosk = $false
  devTools = $false
}

$config | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $configPath -Encoding UTF8
