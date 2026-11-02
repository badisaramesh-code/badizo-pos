param([string]$OutputRoot = 'D:\badizo-pos-main\output\new-store-20260920\package')
$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
function CopyTree($source,$dest,$extra=@()) {
  New-Item -ItemType Directory -Force $dest | Out-Null
  & robocopy.exe $source $dest /E /NFL /NDL /NJH /NJS /NP /R:1 /W:1 @extra | Out-Null
  if ($LASTEXITCODE -ge 8) { throw "Copy failed: $source" }
}
if (Test-Path $OutputRoot) { throw "Use a new package directory: $OutputRoot" }
$payload = Join-Path $OutputRoot 'payload'
New-Item -ItemType Directory -Force "$payload\app\backend","$payload\app\frontend","$payload\runtime","$payload\mysql" | Out-Null
foreach ($dir in @('config','middleware','routes','services','utils','node_modules')) {
  CopyTree "$repo\backend\$dir" "$payload\app\backend\$dir" @('/XF','*.bak','*.log','*_backup_*','.env*')
}
Copy-Item "$repo\backend\server.js","$repo\backend\package.json","$repo\backend\package-lock.json" "$payload\app\backend"
CopyTree "$repo\output\new-store-20260920\frontend-build" "$payload\app\frontend\build"
CopyTree "$repo\barcode\templates" "$payload\app\barcode\templates"
CopyTree "$repo\thermal" "$payload\app\thermal"
CopyTree "$repo\electron\assets" "$payload\app\assets"
Copy-Item (Get-Command node.exe).Source "$payload\runtime\node.exe"
$mysqlSource = 'C:\Program Files\MySQL\MySQL Server 8.0'
foreach ($dir in @('bin','lib','share','docs')) {
  CopyTree "$mysqlSource\$dir" "$payload\mysql\$dir" @('/XF','*-debug*','*.pdb')
}
Copy-Item "$mysqlSource\LICENSE","$mysqlSource\README" "$payload\mysql"
Copy-Item "$repo\scripts\windows\setup-slave-app.ps1" "$payload\setup-slave-app.ps1"
Write-Output "Staged clean application and runtime: $OutputRoot"
