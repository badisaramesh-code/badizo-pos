$ErrorActionPreference = 'Stop'

$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object Security.Principal.WindowsPrincipal($identity)
if (!$principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  throw 'Run UPDATE_LOCAL_LEDGER_DELETE.bat and approve the administrator prompt.'
}

$repo = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$manifest = Get-Content -LiteralPath (Join-Path $repo 'outputs\combined-app-deploy-20261113\manifest.json') -Raw | ConvertFrom-Json
$live = [System.IO.Path]::GetFullPath([string]$manifest.live)
if ($live -notlike 'C:\Program Files\Badizo-*\release') { throw "Unexpected Badizo install path: $live" }

$sourceBackend = Join-Path $repo 'backend\routes\localAccounts.js'
$targetBackend = Join-Path $live 'backend\routes\localAccounts.js'
$sourceDiaryService = Join-Path $repo 'backend\services\paymentDiary.js'
$targetDiaryService = Join-Path $live 'backend\services\paymentDiary.js'
$sourceBuild = Join-Path $repo 'frontend\build'
$targetBuild = Join-Path $live 'frontend\build'
if (!(Test-Path -LiteralPath $sourceBackend) -or !(Test-Path -LiteralPath $sourceDiaryService) -or !(Test-Path -LiteralPath $sourceBuild)) { throw 'Updated source files are missing.' }
if (!(Test-Path -LiteralPath $targetBackend) -or !(Test-Path -LiteralPath $targetDiaryService) -or !(Test-Path -LiteralPath (Join-Path $targetBuild 'index.html'))) { throw 'Installed Badizo files are missing.' }

$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$backup = Join-Path $repo "outputs\local-ledger-delete-20261119\live-backup-$stamp"
New-Item -ItemType Directory -Path (Join-Path $backup 'backend\routes') -Force | Out-Null
New-Item -ItemType Directory -Path (Join-Path $backup 'backend\services') -Force | Out-Null
New-Item -ItemType Directory -Path (Join-Path $backup 'frontend\build') -Force | Out-Null
Copy-Item -LiteralPath $targetBackend -Destination (Join-Path $backup 'backend\routes\localAccounts.js')
Copy-Item -LiteralPath $targetDiaryService -Destination (Join-Path $backup 'backend\services\paymentDiary.js')
Get-ChildItem -LiteralPath $targetBuild -File -Recurse | ForEach-Object {
  $relative = $_.FullName.Substring($targetBuild.Length + 1)
  $destination = Join-Path $backup "frontend\build\$relative"
  New-Item -ItemType Directory -Path (Split-Path -Parent $destination) -Force | Out-Null
  Copy-Item -LiteralPath $_.FullName -Destination $destination -Force
}

$service = Get-Service -Name 'BadizoServer' -ErrorAction Stop
if ($service.Status -eq 'Running') { Stop-Service -Name 'BadizoServer' -Force; $service.WaitForStatus('Stopped',[TimeSpan]::FromSeconds(30)) }
try {
  Copy-Item -LiteralPath $sourceBackend -Destination $targetBackend -Force
  Copy-Item -LiteralPath $sourceDiaryService -Destination $targetDiaryService -Force
  Get-ChildItem -LiteralPath $sourceBuild -File -Recurse | ForEach-Object {
    $relative = $_.FullName.Substring($sourceBuild.Length + 1)
    $destination = Join-Path $targetBuild $relative
    New-Item -ItemType Directory -Path (Split-Path -Parent $destination) -Force | Out-Null
    Copy-Item -LiteralPath $_.FullName -Destination $destination -Force
  }
} finally {
  Start-Service -Name 'BadizoServer'
}

$health = $null
for ($attempt = 1; $attempt -le 30; $attempt++) {
  try { $health = Invoke-RestMethod -Uri 'http://127.0.0.1:5000/api/health' -TimeoutSec 3; if ($health.ok) { break } } catch { }
  Start-Sleep -Seconds 2
}
if (!$health -or !$health.ok) { throw "Badizo did not become healthy. Backup: $backup" }
$mainAsset = (Get-Content -LiteralPath (Join-Path $sourceBuild 'asset-manifest.json') -Raw | ConvertFrom-Json).files.'main.js'
$mainBundle = [System.IO.Path]::GetFileName([string]$mainAsset)
$html = (Invoke-WebRequest -Uri 'http://127.0.0.1:5000/' -UseBasicParsing -TimeoutSec 5).Content
if ([string]::IsNullOrWhiteSpace($mainBundle) -or $html -notmatch [regex]::Escape($mainBundle)) { throw "Updated frontend is not being served. Backup: $backup" }
Write-Host "Updated installed Badizo without changing settings. Backup: $backup" -ForegroundColor Green
