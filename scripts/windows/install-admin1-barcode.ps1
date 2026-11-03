$ErrorActionPreference = 'Stop'

try {
  if (Get-Process -Name Badizo -ErrorAction SilentlyContinue) {
    throw 'Close every BADIZO window, then run INSTALL_ADMIN1.cmd again.'
  }
  $sourceDir = Join-Path $PSScriptRoot 'app'
  if (!(Test-Path -LiteralPath (Join-Path $sourceDir 'Badizo.exe'))) {
    throw 'Extract the entire ZIP before running INSTALL_ADMIN1.cmd. The app folder is missing.'
  }
  $installDir = Join-Path $env:LOCALAPPDATA 'BadizoAdmin1Barcode-20261021-v2'
  New-Item -ItemType Directory -Force -Path $installDir | Out-Null
  Get-ChildItem -LiteralPath $sourceDir -Force | Copy-Item -Destination $installDir -Recurse -Force
  $sourceArchive = Join-Path $sourceDir 'resources\app.asar'
  $installedArchive = Join-Path $installDir 'resources\app.asar'
  if ((Get-FileHash -LiteralPath $sourceArchive).Hash -ne (Get-FileHash -LiteralPath $installedArchive).Hash) {
    throw 'Installed app verification failed. Extract the full ZIP and run the installer again.'
  }
  & (Join-Path $PSScriptRoot 'apply-admin1-stability.ps1')
  Write-Host 'Updated app installed and verified.' -ForegroundColor Green
  Write-Host 'In Barcode Stickers click Refresh Printers and select the printer used for the working Windows test page.'
  Start-Process -FilePath (Join-Path $installDir 'OPEN_ADMIN1.cmd') -WorkingDirectory $installDir -WindowStyle Hidden

} catch {
  Write-Host $_.Exception.Message -ForegroundColor Red
  exit 1
}
