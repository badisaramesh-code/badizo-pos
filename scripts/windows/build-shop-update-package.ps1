param(
  [string]$ServerIp = '192.168.1.12',
  [string]$OutputDir = '',
  [switch]$SkipInstallerBuild,
  [switch]$SkipInstall
)

$ErrorActionPreference = 'Stop'

function Write-Step {
  param([string]$Message)
  Write-Host ''
  Write-Host "== $Message ==" -ForegroundColor Cyan
}

function Copy-DirectoryWithoutNoise {
  param(
    [string]$Source,
    [string]$Destination,
    [string[]]$ExcludedNames
  )

  if (!(Test-Path $Source)) {
    throw "Source folder missing: $Source"
  }

  if (Test-Path $Destination) {
    Remove-Item -Path $Destination -Recurse -Force
  }

  New-Item -ItemType Directory -Force -Path $Destination | Out-Null
  Get-ChildItem -Path $Source -Force | Where-Object {
    $ExcludedNames -notcontains $_.Name
  } | ForEach-Object {
    Copy-Item -Path $_.FullName -Destination $Destination -Recurse -Force
  }
}

$scriptRoot = $PSScriptRoot
$appRoot = Split-Path -Parent (Split-Path -Parent $scriptRoot)
$electronDist = Join-Path $appRoot 'electron\dist'

if ([string]::IsNullOrWhiteSpace($OutputDir)) {
  $OutputDir = Join-Path $appRoot 'dist\shop-update'
}

if (!$SkipInstallerBuild) {
  Write-Step 'Building latest Electron installer'
  $builder = Join-Path $scriptRoot 'build-electron-installer.ps1'
  & $builder -ServerIp $ServerIp -SkipInstall:$SkipInstall
}

Write-Step 'Preparing shop update package'
New-Item -ItemType Directory -Force -Path $OutputDir | Out-Null

Copy-DirectoryWithoutNoise `
  -Source (Join-Path $appRoot 'backend') `
  -Destination (Join-Path $OutputDir 'backend') `
  -ExcludedNames @('node_modules', 'backups', 'logs', 'server.out.log', 'server.err.log')

Copy-DirectoryWithoutNoise `
  -Source (Join-Path $appRoot 'frontend') `
  -Destination (Join-Path $OutputDir 'frontend') `
  -ExcludedNames @('node_modules', 'build', 'logs')

Copy-DirectoryWithoutNoise `
  -Source (Join-Path $appRoot 'scripts') `
  -Destination (Join-Path $OutputDir 'scripts') `
  -ExcludedNames @()

$rootFilesToCopy = @(
  (Join-Path $scriptRoot 'apply-shop-update-one-click.bat'),
  (Join-Path $appRoot 'SHOP_UPDATE.md')
)

foreach ($file in $rootFilesToCopy) {
  if (!(Test-Path $file)) {
    throw "Required package file missing: $file"
  }

  Copy-Item -Path $file -Destination $OutputDir -Force
}

$installer = Get-ChildItem -Path $electronDist -Filter 'Badizo Setup*.exe' -File -ErrorAction SilentlyContinue |
  Sort-Object LastWriteTime -Descending |
  Select-Object -First 1

if ($installer) {
  Copy-Item -Path $installer.FullName -Destination $OutputDir -Force
}

Write-Step 'Update package ready'
Write-Host "Folder: $OutputDir" -ForegroundColor Green
Write-Host ''
Write-Host 'At the shop server, copy this package over the existing Badizo app folder, then double-click:'
Write-Host 'apply-shop-update-one-click.bat' -ForegroundColor Green
Write-Host ''
if ($installer) {
  Write-Host 'For slave PCs, reinstall/update using:'
  Write-Host $installer.Name
}
