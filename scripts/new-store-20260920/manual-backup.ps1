$ErrorActionPreference='Stop'
try {
 & (Join-Path $PSScriptRoot 'verify-package.ps1')
 $script='C:\BadizoPOS\backup-local.ps1'
 if (!(Test-Path $script)) {throw 'Run this on the NEW STORE server after installation.'}
 $p=Start-Process -Verb RunAs -FilePath "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" -ArgumentList ('-NoProfile -ExecutionPolicy Bypass -File "'+$script+'" -Force') -WindowStyle Hidden -Wait -PassThru
 if ($p.ExitCode -ne 0) {throw 'Backup failed. Administrator: inspect C:\BadizoPOS\backups\backup-errors.log.'}
 Write-Host 'BACKUP COMPLETE: C:\BadizoPOS\backups (SQL + PRN + thermal ZIP)' -ForegroundColor Green
} catch {Write-Host $_.Exception.Message -ForegroundColor Red; exit 1}
