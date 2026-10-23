param(
  [ValidateSet('all', 'admin', 'counter', 'security', 'server')]
  [string]$LoginMode = 'all',
  [string]$ServerHost = '192.168.1.10'
)
$ErrorActionPreference = 'Stop'
try {
  if (Get-Process -Name Badizo -ErrorAction SilentlyContinue) { throw 'Close all BADIZO app windows on this computer, then run this installer again.' }
  $source = Join-Path $PSScriptRoot 'app'
  $manifestPath = Join-Path $PSScriptRoot 'app-files.json'
  if (!(Test-Path -LiteralPath $manifestPath)) { throw 'Extract the entire ZIP first. App verification manifest is missing.' }
  $manifest = @(Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json)
  if (!$manifest.Count) { throw 'The app verification manifest is empty. Extract the complete package.' }
  $sourceRoot = [IO.Path]::GetFullPath($source).TrimEnd('\') + '\'
  foreach ($file in $manifest) {
    $sourcePath = [IO.Path]::GetFullPath((Join-Path $source $file.path))
    if (!$sourcePath.StartsWith($sourceRoot, [StringComparison]::OrdinalIgnoreCase)) { throw 'Invalid app manifest path.' }
    if (!(Test-Path -LiteralPath $sourcePath -PathType Leaf) -or (Get-FileHash -LiteralPath $sourcePath).Hash -ne $file.sha256) { throw "App file is incomplete or damaged: $($file.path). Copy the ZIP again and Extract All." }
  }
  if (!(Test-Path -LiteralPath (Join-Path $source 'Badizo.exe'))) { throw 'The app folder is missing. Extract the full ZIP.' }
  if ($ServerHost -notmatch '^[A-Za-z0-9.-]+$') { throw 'ServerHost must be a LAN hostname or IPv4 address.' }
  $isServer = $LoginMode -eq 'server'
  if ($isServer) { $ServerHost = '127.0.0.1' }
  $installDir = Join-Path $env:LOCALAPPDATA 'BadizoPOSStable-20261021'
  New-Item -ItemType Directory -Force -Path $installDir | Out-Null
  Get-ChildItem -LiteralPath $source -Force | Copy-Item -Destination $installDir -Recurse -Force
  if ((Get-FileHash -LiteralPath (Join-Path $source 'resources\app.asar')).Hash -ne (Get-FileHash -LiteralPath (Join-Path $installDir 'resources\app.asar')).Hash) { throw 'Installed app verification failed.' }
  $shortcutName = switch ($LoginMode) {
    'admin' { 'BADIZO Admin Stable' }
    'counter' { 'BADIZO Counter Stable' }
    'security' { 'BADIZO Security Stable' }
    'server' { 'BADIZO Server Stable' }
    default { 'BADIZO POS Stable' }
  }
  $settings = [ordered]@{
    appUrl = "http://${ServerHost}:5000?loginMode=$LoginMode"
    apiHealthUrl = "http://${ServerHost}:5000/api/health"
    backendPort = 5000; frontendPort = 5000
    startBackend = $false; startFrontend = $false
    serverHosts = @($ServerHost, '192.168.1.10', 'badizo-server.local', 'badizo-server', 'server')
    discoveryEnabled = $true; discoveryTimeoutMs = 12000
    allowLoopbackServer = $isServer
    loginMode = $LoginMode; loginUser = ''
    shortcutName = $shortcutName
    kiosk = $false; devTools = $false
  }
  $configPath = Join-Path $installDir 'client-settings.json'
  if (Test-Path -LiteralPath $configPath) { Copy-Item -LiteralPath $configPath -Destination ($configPath + '.previous') -Force }
  $settings | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $configPath -Encoding UTF8
  Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'repair-admin1-shortcuts.ps1') -Destination $installDir -Force
  @'
@echo off
setlocal
set "BADIZO_CLIENT_CONFIG=%~dp0client-settings.json"
set "BADIZO_APP_URL="
set "BADIZO_API_HEALTH_URL="
set "BADIZO_LOGIN_MODE="
set "BADIZO_LOGIN_USER="
set "BADIZO_SERVER_HOSTS="
powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "%~dp0repair-admin1-shortcuts.ps1" -Quiet
if not exist "%~dp0Badizo.exe" (
  echo BADIZO app files are missing. Run the verified installer again.
  pause
  exit /b 1
)
start "" "%~dp0Badizo.exe"
endlocal
'@ | Set-Content -LiteralPath (Join-Path $installDir 'OPEN_ADMIN1.cmd') -Encoding ASCII
  & (Join-Path $installDir 'repair-admin1-shortcuts.ps1') -InstallLogonRepair
  Write-Host "Verified installation completed. Open $shortcutName from Desktop or Start." -ForegroundColor Green
  Write-Host 'For barcodes, select the local Windows printer used for the working test page.'
} catch {
  Write-Host $_.Exception.Message -ForegroundColor Red
  exit 1
}
