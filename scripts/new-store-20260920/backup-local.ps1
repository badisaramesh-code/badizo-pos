param([string]$InstallRoot='C:\BadizoPOS',[switch]$Force,[switch]$TestMode)
$ErrorActionPreference='Stop'
if ($TestMode) {
 $qaAllowed=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..\output\new-store-20260920\qa'))+'\'
 if (![IO.Path]::GetFullPath($InstallRoot).StartsWith($qaAllowed,[StringComparison]::OrdinalIgnoreCase)) {throw 'TestMode requires the isolated release QA directory'}
} elseif ([IO.Path]::GetFullPath($InstallRoot).TrimEnd('\') -ne 'C:\BadizoPOS') {throw 'Unexpected production install root'}
$mutex=New-Object Threading.Mutex($false,'Global\BadizoNewStoreLocalBackup')
if (!$mutex.WaitOne(0)) {Write-Host 'Backup already running'; exit 0}
$work=$null
try {
 $now=Get-Date
 if (!$Force -and $now.Hour -lt 9) {exit 0}
 $dir=Join-Path $InstallRoot 'backups'
 New-Item -ItemType Directory -Force $dir | Out-Null
 & icacls.exe $dir /inheritance:r /grant:r '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' | Out-Null
 if ($LASTEXITCODE -ne 0) {throw 'Cannot protect backup folder'}
 if ($TestMode) {$qaSid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value; & icacls.exe $dir /grant:r ('*'+$qaSid+':(OI)(CI)F') | Out-Null; if($LASTEXITCODE -ne 0){throw 'QA ACL failed'}}
 $day=$now.ToString('yyyy-MM-dd')
 $marker=Join-Path $dir 'last-local-backup.json'
 if (!$Force -and (Test-Path $marker)) {
  $previous=Get-Content $marker -Raw | ConvertFrom-Json
  if ($previous.day -eq $day -and (Test-Path -LiteralPath $previous.archive)) {exit 0}
 }
 $stamp=$now.ToString('yyyyMMdd-HHmmss-fff')
 $work=Join-Path $dir ('work-'+$stamp)
 New-Item -ItemType Directory $work | Out-Null
 & (Join-Path $InstallRoot 'runtime\node.exe') (Join-Path $InstallRoot 'backup-dump.cjs') $InstallRoot (Join-Path $work 'database.sql')
 if ($LASTEXITCODE -ne 0) {throw 'SQL backup failed'}
 foreach ($relative in @('barcode\templates','barcode\output','thermal')) {
  $src=Join-Path $InstallRoot $relative
  if (Test-Path $src) {
   $dst=Join-Path $work $relative
   New-Item -ItemType Directory -Force $dst | Out-Null
   & robocopy.exe $src $dst /E /NFL /NDL /NJH /NJS /NP /R:1 /W:1 | Out-Null
   if ($LASTEXITCODE -ge 8) {throw ('Backup copy failed: '+$relative)}
  }
 }
 @{created=$now.ToString('o');contents='database.sql; barcode templates and generated PRN output; thermal templates';server='192.168.1.10'} | ConvertTo-Json | Set-Content (Join-Path $work 'manifest.json') -Encoding UTF8
 $zip=Join-Path $dir ('BADIZO-'+$stamp+'.zip')
 Add-Type -AssemblyName System.IO.Compression.FileSystem
 [IO.Compression.ZipFile]::CreateFromDirectory($work,$zip)
 $archive=[IO.Compression.ZipFile]::OpenRead($zip)
 try {if (!$archive.GetEntry('database.sql') -or !$archive.GetEntry('manifest.json')) {throw 'Backup ZIP verification failed'}} finally {$archive.Dispose()}
 @{day=$day;archive=$zip;completed=(Get-Date).ToString('o')} | ConvertTo-Json | Set-Content $marker -Encoding UTF8
 Write-Host ('Backup verified: '+$zip)
} catch {
 if (Test-Path (Join-Path $InstallRoot 'backups')) { ('{0} FAILED {1}' -f (Get-Date),$_.Exception.Message) | Add-Content (Join-Path $InstallRoot 'backups\backup-errors.log') }
 Write-Error $_
 exit 1
} finally {
 if ($work -and (Test-Path $work)) {
  $resolved=[IO.Path]::GetFullPath($work)
  $allowed=[IO.Path]::GetFullPath((Join-Path $InstallRoot 'backups'))+'\'
  if ($resolved.StartsWith($allowed,[StringComparison]::OrdinalIgnoreCase)) {Remove-Item -LiteralPath $resolved -Recurse -Force}
 }
 $mutex.ReleaseMutex();$mutex.Dispose()
}
