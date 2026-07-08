$ErrorActionPreference = 'Stop'

$startupDir = [Environment]::GetFolderPath('Startup')
$backendScript = Join-Path $PSScriptRoot 'start-backend.ps1'
$frontendScript = Join-Path $PSScriptRoot 'start-frontend.ps1'
$backendCmd = Join-Path $startupDir 'Badizo POS Backend.cmd'
$frontendCmd = Join-Path $startupDir 'Badizo POS Frontend.cmd'
$backendVbs = Join-Path $startupDir 'Badizo POS Backend.vbs'
$frontendVbs = Join-Path $startupDir 'Badizo POS Frontend.vbs'

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

Set-Content -LiteralPath $backendVbs -Encoding ASCII -Value @"
Set shell = CreateObject("WScript.Shell")
shell.Run "powershell.exe -NoProfile -ExecutionPolicy Bypass -File ""$backendScript""", 0, False
"@

Set-Content -LiteralPath $frontendVbs -Encoding ASCII -Value @"
Set shell = CreateObject("WScript.Shell")
shell.Run "powershell.exe -NoProfile -ExecutionPolicy Bypass -File ""$frontendScript""", 0, False
"@

Write-Host "Installed current-user startup launchers:"
Write-Host $backendCmd
Write-Host $frontendCmd
Write-Host $backendVbs
Write-Host $frontendVbs
