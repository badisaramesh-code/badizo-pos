$ErrorActionPreference = 'Stop'

$startupDir = [Environment]::GetFolderPath('Startup')
$backendScript = Join-Path $PSScriptRoot 'start-backend.ps1'
$launcherPath = Join-Path $startupDir 'Badizo POS Backend.vbs'

if (!(Test-Path $backendScript)) {
  throw "Cannot find $backendScript"
}

$escapedScript = $backendScript.Replace('"', '""')
$launcher = @"
Set shell = CreateObject("WScript.Shell")
shell.Run "powershell.exe -NoProfile -ExecutionPolicy Bypass -File ""$escapedScript""", 0, False
"@

Set-Content -LiteralPath $launcherPath -Encoding ASCII -Value $launcher
Write-Host "Installed current-user backend startup launcher: $launcherPath"
