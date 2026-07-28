$ErrorActionPreference = 'Stop'
$printerUser = 'badizo-printer'
$printerPassword = 'BadizoPrint#244'
$shareName = 'TSC-244-2'

try {
  Write-Host 'Configuring Admin1 printer network access...' -ForegroundColor Cyan
  $existingUser = Get-LocalUser -Name $printerUser -ErrorAction SilentlyContinue
  $securePassword = ConvertTo-SecureString $printerPassword -AsPlainText -Force
  if ($existingUser) {
    Set-LocalUser -Name $printerUser -Password $securePassword -PasswordNeverExpires $true
  } else {
    New-LocalUser -Name $printerUser -Password $securePassword -PasswordNeverExpires -AccountNeverExpires -Description 'Badizo barcode printer network access' | Out-Null
  }
  Enable-LocalUser -Name $printerUser
  Add-LocalGroupMember -Group 'Users' -Member $printerUser -ErrorAction SilentlyContinue

  $printer = Get-Printer -Name 'TSC TE244' -ErrorAction SilentlyContinue
  if (!$printer) {
    $printer = Get-Printer | Where-Object { $_.Name -match 'TSC.*(TE244|244)' } | Select-Object -First 1
  }
  if (!$printer) { throw 'TSC TE244 printer was not found on Admin1.' }
  Set-Printer -Name $printer.Name -Shared $true -ShareName $shareName

  Set-Service -Name LanmanServer -StartupType Automatic
  Start-Service -Name LanmanServer
  Set-Service -Name Spooler -StartupType Automatic
  Start-Service -Name Spooler
  Set-SmbServerConfiguration -EnableSMB2Protocol $true -Force | Out-Null
  Get-NetConnectionProfile -ErrorAction SilentlyContinue |
    Where-Object { $_.NetworkCategory -eq 'Public' } |
    Set-NetConnectionProfile -NetworkCategory Private -ErrorAction SilentlyContinue
  Get-NetFirewallRule -DisplayGroup 'File and Printer Sharing' -ErrorAction SilentlyContinue |
    Set-NetFirewallRule -Enabled True -Profile Any
  & netsh.exe advfirewall firewall delete rule name='Badizo Admin1 SMB Printer 445' | Out-Null
  & netsh.exe advfirewall firewall add rule name='Badizo Admin1 SMB Printer 445' dir=in action=allow protocol=TCP localport=445 profile=any | Out-Null

  Write-Host ''
  Write-Host 'SUCCESS: Admin1 printer network access is ready.' -ForegroundColor Green
  Write-Host "Printer: $($printer.Name)"
  Write-Host "Share: \\$env:COMPUTERNAME\$shareName"
  Write-Host "Network user: $printerUser"
  exit 0
} catch {
  Write-Host $_.Exception.Message -ForegroundColor Red
  exit 1
}
