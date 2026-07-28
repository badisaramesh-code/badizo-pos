$ErrorActionPreference = 'Stop'
$printerUser = 'badizo-printer'
$printerPassword = 'BadizoPrint#244'
$shareName = 'TSC-244-2'

try {
  Write-Host 'Configuring Admin1 printer and Windows SMB sharing...' -ForegroundColor Cyan

  $securePassword = ConvertTo-SecureString $printerPassword -AsPlainText -Force
  $existingUser = Get-LocalUser -Name $printerUser -ErrorAction SilentlyContinue
  if ($existingUser) {
    Set-LocalUser -Name $printerUser -Password $securePassword -PasswordNeverExpires $true
  } else {
    New-LocalUser -Name $printerUser -Password $securePassword -PasswordNeverExpires -AccountNeverExpires -Description 'Badizo barcode printer network access' | Out-Null
  }
  Enable-LocalUser -Name $printerUser

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
    Where-Object { $_.IPv4Connectivity -ne 'Disconnected' -or $_.IPv6Connectivity -ne 'Disconnected' } |
    Set-NetConnectionProfile -NetworkCategory Private -ErrorAction SilentlyContinue

  Get-NetFirewallRule -DisplayGroup 'File and Printer Sharing' -ErrorAction SilentlyContinue |
    Set-NetFirewallRule -Enabled True -Profile Any

  & netsh.exe advfirewall firewall delete rule name='Badizo Admin1 SMB Printer 445' | Out-Null
  & netsh.exe advfirewall firewall add rule name='Badizo Admin1 SMB Printer 445' dir=in action=allow protocol=TCP localport=445 profile=any | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'Unable to open Windows Firewall TCP port 445.' }

  $sharedPrinter = Get-Printer -Name $printer.Name
  if (!$sharedPrinter.Shared -or $sharedPrinter.ShareName -ne $shareName) {
    throw 'Printer sharing verification failed.'
  }

  Write-Host ''
  Write-Host 'SUCCESS: Admin1 printer SMB sharing is ready.' -ForegroundColor Green
  Write-Host "Printer share: \\$env:COMPUTERNAME\$shareName"
  Write-Host 'Restart Admin1 once, then reconnect from the Server.'
  exit 0
} catch {
  Write-Host "FAILED: $($_.Exception.Message)" -ForegroundColor Red
  exit 1
}
