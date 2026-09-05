param(
  [string]$OutputDir = '',
  [switch]$CreateZip
)

$ErrorActionPreference = 'Stop'
$scriptRoot = $PSScriptRoot
$appRoot = Split-Path -Parent (Split-Path -Parent $scriptRoot)
if ([string]::IsNullOrWhiteSpace($OutputDir)) {
  $OutputDir = Join-Path $appRoot 'output\BADIZO_NEW_STORE_OFFLINE_PACKAGE'
}

function Copy-CleanFolder([string]$Source, [string]$Destination, [string[]]$Exclude) {
  if (Test-Path -LiteralPath $Destination) { Remove-Item -LiteralPath $Destination -Recurse -Force }
  New-Item -ItemType Directory -Force -Path $Destination | Out-Null
  Get-ChildItem -LiteralPath $Source -Force | Where-Object { $Exclude -notcontains $_.Name } |
    ForEach-Object { Copy-Item -LiteralPath $_.FullName -Destination $Destination -Recurse -Force }
}

$node = (Get-Command node.exe -ErrorAction Stop).Source
$installer = Get-ChildItem -LiteralPath (Join-Path $appRoot 'electron\dist') -Filter 'Badizo Setup*.exe' -File |
  Sort-Object LastWriteTime -Descending | Select-Object -First 1
if (!$installer) { throw 'Badizo Setup installer is missing from electron\dist.' }
foreach ($required in @('backend\node_modules', 'frontend\build\index.html')) {
  if (!(Test-Path -LiteralPath (Join-Path $appRoot $required))) { throw "Required build asset missing: $required" }
}

if (Test-Path -LiteralPath $OutputDir) { Remove-Item -LiteralPath $OutputDir -Recurse -Force }
New-Item -ItemType Directory -Force -Path (Join-Path $OutputDir 'payload\app') | Out-Null
Copy-CleanFolder (Join-Path $appRoot 'backend') (Join-Path $OutputDir 'payload\app\backend') @('backups','logs','.env')
Copy-CleanFolder (Join-Path $appRoot 'frontend\build') (Join-Path $OutputDir 'payload\app\frontend\build') @()
New-Item -ItemType Directory -Force -Path (Join-Path $OutputDir 'payload\runtime') | Out-Null
Copy-Item -LiteralPath $node -Destination (Join-Path $OutputDir 'payload\runtime\node.exe') -Force
Copy-Item -LiteralPath $installer.FullName -Destination (Join-Path $OutputDir 'payload\Badizo Setup 1.0.0.exe') -Force
Copy-Item -LiteralPath (Join-Path $scriptRoot 'setup-slave-app.ps1') -Destination (Join-Path $OutputDir 'payload\setup-slave-app.ps1') -Force
Copy-Item -LiteralPath (Join-Path $scriptRoot 'install-new-store-offline.ps1') -Destination (Join-Path $OutputDir 'payload\install-new-store.ps1') -Force
Copy-Item -LiteralPath (Join-Path $scriptRoot 'configure-google-drive-backup.ps1') -Destination (Join-Path $OutputDir 'payload\configure-google-drive-backup.ps1') -Force
Copy-Item -LiteralPath (Join-Path $scriptRoot 'CONFIGURE_GOOGLE_DRIVE_BACKUP.bat') -Destination (Join-Path $OutputDir 'CONFIGURE_GOOGLE_DRIVE_BACKUP.bat') -Force
Copy-Item -LiteralPath (Join-Path $scriptRoot 'CHECK_BADIZO_LAN.bat') -Destination (Join-Path $OutputDir 'CHECK_BADIZO_LAN.bat') -Force
Copy-Item -LiteralPath (Join-Path $scriptRoot 'RUN_BADIZO_NEW_STORE_INSTALL.bat') -Destination (Join-Path $OutputDir 'RUN_BADIZO_NEW_STORE_INSTALL.bat') -Force
$guide = Join-Path $appRoot 'output\pdf\BADIZO_NEW_STORE_INSTALL_GUIDE_TELUGU_ENGLISH.pdf'
if (Test-Path -LiteralPath $guide) {
  Copy-Item -LiteralPath $guide -Destination (Join-Path $OutputDir 'BADIZO_NEW_STORE_INSTALL_GUIDE_TELUGU_ENGLISH.pdf') -Force
}

$manifest = Get-ChildItem -LiteralPath $OutputDir -Recurse -File |
  Where-Object Name -ne 'FILE_CHECKSUMS_SHA256.csv' | ForEach-Object {
  [pscustomobject]@{ Path = $_.FullName.Substring($OutputDir.Length + 1); SHA256 = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash }
}
$manifest | Export-Csv -LiteralPath (Join-Path $OutputDir 'FILE_CHECKSUMS_SHA256.csv') -NoTypeInformation -Encoding UTF8

if ($CreateZip) {
  $zip = "$OutputDir.zip"
  if (Test-Path -LiteralPath $zip) { Remove-Item -LiteralPath $zip -Force }
  Compress-Archive -LiteralPath $OutputDir -DestinationPath $zip -CompressionLevel Optimal
  Write-Host "ZIP: $zip" -ForegroundColor Green
}
Write-Host "Offline package: $OutputDir" -ForegroundColor Green


