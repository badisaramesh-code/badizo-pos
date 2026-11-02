$ErrorActionPreference = 'Stop'
try {
  $installDir = Join-Path $env:LOCALAPPDATA 'BadizoAdmin1Barcode-20261021-v2'
  if (!(Test-Path -LiteralPath (Join-Path $installDir 'Badizo.exe') -PathType Leaf)) {
    throw 'Run this update on Admin1 with the same Windows login used to install the working barcode app.'
  }
  $repairSource = Join-Path $PSScriptRoot 'repair-admin1-shortcuts.ps1'
  $repairDestination = Join-Path $installDir 'repair-admin1-shortcuts.ps1'
  Copy-Item -LiteralPath $repairSource -Destination $repairDestination -Force
  $launcher = Join-Path $installDir 'OPEN_ADMIN1.cmd'
  if ((Test-Path -LiteralPath $launcher) -and !(Test-Path -LiteralPath ($launcher + '.before-stability'))) {
    Copy-Item -LiteralPath $launcher -Destination ($launcher + '.before-stability')
  }
  @'
@echo off
setlocal
if not exist "%~dp0Badizo.exe" (
  echo BADIZO app files are missing. Restore the installed app before launching.
  pause
  exit /b 1
)
powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "%~dp0repair-admin1-shortcuts.ps1" -Quiet
set "BADIZO_APP_URL=http://192.168.1.10:5000?loginMode=admin&loginUser=admin1"
set "BADIZO_API_HEALTH_URL=http://192.168.1.10:5000/api/health"
set "BADIZO_SERVER_HOSTS=192.168.1.10,badizo-server.local,badizo-server,server"
set "BADIZO_LOGIN_MODE=admin"
set "BADIZO_LOGIN_USER=admin1"
start "" "%~dp0Badizo.exe"
endlocal
'@ | Set-Content -LiteralPath $launcher -Encoding ASCII
  & $repairDestination -InstallLogonRepair
  Write-Host 'Shortcut recovery enabled at Windows login and each app launch.' -ForegroundColor Green
  Write-Host 'Open BADIZO Admin1 Barcode from Desktop or the Start menu.'
} catch {
  Write-Host $_.Exception.Message -ForegroundColor Red
  throw
}
