$ErrorActionPreference = 'Continue'
$expectedShare = 'TSC-244-2'
$printer = Get-Printer -Name 'TSC TE244' -ErrorAction SilentlyContinue
if (!$printer) {
  $printer = Get-Printer -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -match 'TSC.*(TE244|244)' } |
    Select-Object -First 1
}

Write-Host 'BADIZO ADMIN1 PRINTER VERIFICATION' -ForegroundColor Cyan
if (!$printer) {
  Write-Host 'FAIL: TSC TE244 printer was not found.' -ForegroundColor Red
  exit 1
}

$spooler = Get-Service Spooler -ErrorAction SilentlyContinue
$localPath = "\\localhost\$expectedShare"
Write-Host "Printer: $($printer.Name)"
Write-Host "Driver: $($printer.DriverName)"
Write-Host "Port: $($printer.PortName)"
Write-Host "Shared: $($printer.Shared)"
Write-Host "Share name: $($printer.ShareName)"
Write-Host "Local path: $localPath"
Write-Host "Spooler: $($spooler.Status)"
Write-Host 'Template: 33 x 25 mm 2-up; row SIZE 68 mm x 25 mm; GAP 2 mm'

$ok = $printer.Shared -and $printer.ShareName -eq $expectedShare -and $spooler.Status -eq 'Running'
if ($ok) {
  Write-Host 'PASS: Printer settings are correct and do not depend on the computer IP address.' -ForegroundColor Green
  exit 0
}
Write-Host 'FAIL: Run INSTALL_ADMIN1_FINAL.bat as Administrator.' -ForegroundColor Red
exit 1
