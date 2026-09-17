param([Parameter(Mandatory = $true)][string]$PackageRoot)
$ErrorActionPreference = 'Stop'
try {
  $root = (Resolve-Path -LiteralPath $PackageRoot).Path
  $installer = Join-Path $root 'payload\install-new-store.ps1'
  if (!(Test-Path -LiteralPath $installer)) { throw "Installer missing: $installer" }
  $arguments = '-NoProfile -ExecutionPolicy Bypass -File "{0}" -PackageRoot "{1}"' -f $installer, $root
  $process = Start-Process -Verb RunAs -FilePath "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" -ArgumentList $arguments -Wait -PassThru
  exit $process.ExitCode
} catch {
  Write-Host "Server setup could not start: $($_.Exception.Message)" -ForegroundColor Red
  Read-Host 'Press Enter to close' | Out-Null
  exit 1
}
