param(
  [string]$ServerIp = '192.168.1.7',
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

$scriptRoot = $PSScriptRoot
$appRoot = Split-Path -Parent (Split-Path -Parent $scriptRoot)
$electronDist = Join-Path $appRoot 'electron\dist'

if ([string]::IsNullOrWhiteSpace($OutputDir)) {
  $OutputDir = Join-Path $appRoot 'dist\new-shop-deployment'
}

if (!$SkipInstallerBuild) {
  Write-Step 'Building latest Electron installer'
  $builder = Join-Path $scriptRoot 'build-electron-installer.ps1'
  & $builder -ServerIp $ServerIp -SkipInstall:$SkipInstall
}

Write-Step 'Preparing deployment package folder'
New-Item -ItemType Directory -Force -Path $OutputDir | Out-Null

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

$installer = Get-ChildItem -Path $electronDist -Filter 'Badizo Setup*.exe' -File -ErrorAction SilentlyContinue |
  Sort-Object LastWriteTime -Descending |
  Select-Object -First 1

if (!$installer) {
  throw "Badizo Electron installer was not found in $electronDist. Run this script without -SkipInstallerBuild."
}

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
  $installer.FullName,
  (Join-Path $scriptRoot 'setup-new-shop-server-one-click.bat'),
  (Join-Path $scriptRoot 'setup-slave-one-click.bat'),
  (Join-Path $scriptRoot 'setup-slave-app.ps1'),
  (Join-Path $appRoot 'SERVER_SLAVE_SETUP.md'),
  (Join-Path $appRoot 'NEW_SHOP_DEPLOYMENT.md')
)

foreach ($file in $rootFilesToCopy) {
  if (!(Test-Path $file)) {
    throw "Required package file missing: $file"
  }

  Copy-Item -Path $file -Destination $OutputDir -Force
}

Write-Step 'Package ready'
Write-Host "Folder: $OutputDir" -ForegroundColor Green
Write-Host ''
Write-Host 'Give this folder to the installer. On the shop server, double-click:'
Write-Host 'setup-new-shop-server-one-click.bat' -ForegroundColor Green
Write-Host ''
Write-Host 'On each slave PC, keep these files together and double-click:'
Write-Host 'setup-slave-one-click.bat'
Write-Host 'setup-slave-app.ps1'
Write-Host $installer.Name
