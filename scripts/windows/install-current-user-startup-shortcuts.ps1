$ErrorActionPreference = 'Stop'

$startupDir = [Environment]::GetFolderPath('Startup')
$backendScript = Join-Path $PSScriptRoot 'start-backend.ps1'
$frontendScript = Join-Path $PSScriptRoot 'start-frontend.ps1'
$backendCmd = Join-Path $startupDir 'Badizo POS Backend.cmd'
$frontendCmd = Join-Path $startupDir 'Badizo POS Frontend.cmd'

if (!(Test-Path $backendScript)) {
  throw "Cannot find $backendScript"
}

if (!(Test-Path $frontendScript)) {
  throw "Cannot find $frontendScript"
}

Set-Content -LiteralPath $backendCmd -Encoding ASCII -Value @"
@echo off
start "Badizo POS Backend" /min powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$backendScript"
"@

Set-Content -LiteralPath $frontendCmd -Encoding ASCII -Value @"
@echo off
start "Badizo POS Frontend" /min powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$frontendScript"
"@

Write-Host "Installed current-user startup launchers:"
Write-Host $backendCmd
Write-Host $frontendCmd
