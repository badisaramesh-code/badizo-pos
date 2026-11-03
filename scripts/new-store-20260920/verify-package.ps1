param([string]$PackageRoot = (Split-Path $PSScriptRoot))
$ErrorActionPreference='Stop'
$root=(Resolve-Path -LiteralPath $PackageRoot).Path.TrimEnd('\')
$manifest=Join-Path $root 'FILE_CHECKSUMS_SHA256.csv'
if(!(Test-Path $manifest)){throw 'Checksum manifest is missing. Copy the complete package.'}
$rows=@(Import-Csv -LiteralPath $manifest)
if(!$rows.Count){throw 'Checksum manifest is empty.'}
foreach($row in $rows){
  $file=[IO.Path]::GetFullPath((Join-Path $root $row.Path))
  if(!$file.StartsWith($root+'\',[StringComparison]::OrdinalIgnoreCase)){throw 'Invalid manifest path.'}
  if(!(Test-Path -LiteralPath $file -PathType Leaf)){throw ('Missing package file: '+$row.Path)}
  if((Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash -ne $row.SHA256){throw ('Package file changed or damaged: '+$row.Path)}
}
Write-Host ('VERIFIED: '+$rows.Count+' package files.') -ForegroundColor Green
