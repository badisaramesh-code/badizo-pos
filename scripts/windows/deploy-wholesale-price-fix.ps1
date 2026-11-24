$ErrorActionPreference = 'Stop'

$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object Security.Principal.WindowsPrincipal($identity)
if (!$principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  throw 'Run this script from Administrator PowerShell.'
}

$repo = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$serviceParameters = (Get-ItemProperty 'HKLM:\SYSTEM\CurrentControlSet\Services\BadizoServer\Parameters').AppParameters
$serviceEntry = ([string]$serviceParameters).Trim().Trim('"')
$liveBackend = Split-Path -Parent $serviceEntry
$live = [System.IO.Path]::GetFullPath((Split-Path -Parent $liveBackend)).TrimEnd('\')

if ($live -notlike 'C:\Program Files\Badizo-HFM001-*\release') {
  throw "Unexpected Badizo release path: $live"
}
if ((Split-Path -Leaf $serviceEntry) -ne 'server.js' -or (Split-Path -Leaf $liveBackend) -ne 'backend') {
  throw "Unexpected Badizo service entry: $serviceEntry"
}

$sourceRoute = Join-Path $repo 'backend\routes\products.js'
$sourceBuild = Join-Path $repo 'frontend\build'
$targetRoute = Join-Path $live 'backend\routes\products.js'
$targetBuild = Join-Path $live 'frontend\build'
if (!(Test-Path -LiteralPath $sourceRoute) -or !(Test-Path -LiteralPath (Join-Path $sourceBuild 'index.html'))) {
  throw 'Updated source route or frontend build is missing.'
}
if (!(Test-Path -LiteralPath $targetRoute) -or !(Test-Path -LiteralPath (Join-Path $targetBuild 'index.html'))) {
  throw 'Installed Badizo route or frontend build is missing.'
}

$service = Get-Service -Name 'BadizoServer' -ErrorAction Stop
if ($service.Status -ne 'Running') {
  throw "BadizoServer must be running before deployment. Current status: $($service.Status)"
}

$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$backup = Join-Path $repo "outputs\wholesale-price-fix\live-backup-$stamp"
$backupRoute = Join-Path $backup 'backend\routes\products.js'
$backupBuild = Join-Path $backup 'frontend\build'
New-Item -ItemType Directory -Path (Split-Path -Parent $backupRoute) -Force | Out-Null
New-Item -ItemType Directory -Path $backupBuild -Force | Out-Null
Copy-Item -LiteralPath $targetRoute -Destination $backupRoute
Get-ChildItem -LiteralPath $targetBuild -File -Recurse | ForEach-Object {
  $relative = $_.FullName.Substring($targetBuild.Length + 1)
  $destination = Join-Path $backupBuild $relative
  New-Item -ItemType Directory -Path (Split-Path -Parent $destination) -Force | Out-Null
  Copy-Item -LiteralPath $_.FullName -Destination $destination -Force
}

$deploymentStarted = $false
try {
  Stop-Service -Name 'BadizoServer' -Force
  $deploymentStarted = $true
  (Get-Service -Name 'BadizoServer').WaitForStatus('Stopped', [TimeSpan]::FromSeconds(30))

  Copy-Item -LiteralPath $sourceRoute -Destination $targetRoute -Force
  Get-ChildItem -LiteralPath $sourceBuild -File -Recurse | ForEach-Object {
    $relative = $_.FullName.Substring($sourceBuild.Length + 1)
    $destination = Join-Path $targetBuild $relative
    New-Item -ItemType Directory -Path (Split-Path -Parent $destination) -Force | Out-Null
    Copy-Item -LiteralPath $_.FullName -Destination $destination -Force
  }

  Start-Service -Name 'BadizoServer'
  (Get-Service -Name 'BadizoServer').WaitForStatus('Running', [TimeSpan]::FromSeconds(30))

  $healthy = $false
  for ($attempt = 1; $attempt -le 30; $attempt++) {
    try {
      $health = Invoke-RestMethod -Uri 'http://127.0.0.1:5000/api/health' -TimeoutSec 3
      if ($health.ok) { $healthy = $true; break }
    } catch { }
    Start-Sleep -Seconds 2
  }
  if (!$healthy) { throw "Badizo backend did not become healthy. Backup: $backup" }

  $assetManifest = Get-Content -LiteralPath (Join-Path $sourceBuild 'asset-manifest.json') -Raw | ConvertFrom-Json
  $mainBundle = [System.IO.Path]::GetFileName([string]$assetManifest.files.'main.js')
  $html = (Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:5000/' -TimeoutSec 5).Content
  if ([string]::IsNullOrWhiteSpace($mainBundle) -or $html -notmatch [regex]::Escape($mainBundle)) {
    throw "Updated frontend is not being served. Backup: $backup"
  }

  Write-Host "Wholesale price fix deployed and verified. Backup: $backup" -ForegroundColor Green
} catch {
  if ($deploymentStarted) {
    if ((Get-Service -Name 'BadizoServer').Status -eq 'Running') {
      Stop-Service -Name 'BadizoServer' -Force
      (Get-Service -Name 'BadizoServer').WaitForStatus('Stopped', [TimeSpan]::FromSeconds(30))
    }
    Copy-Item -LiteralPath $backupRoute -Destination $targetRoute -Force
    Get-ChildItem -LiteralPath $backupBuild -File -Recurse | ForEach-Object {
      $relative = $_.FullName.Substring($backupBuild.Length + 1)
      $destination = Join-Path $targetBuild $relative
      New-Item -ItemType Directory -Path (Split-Path -Parent $destination) -Force | Out-Null
      Copy-Item -LiteralPath $_.FullName -Destination $destination -Force
    }
    Start-Service -Name 'BadizoServer'
    (Get-Service -Name 'BadizoServer').WaitForStatus('Running', [TimeSpan]::FromSeconds(30))
  }
  throw
}
