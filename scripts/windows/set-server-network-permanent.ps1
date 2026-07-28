param(
  [string]$InterfaceAlias = 'Ethernet',
  [string]$IpAddress = '192.168.1.10',
  [string]$Gateway = '192.168.1.1'
)

$ErrorActionPreference = 'Stop'
$logFile = Join-Path (Split-Path -Parent (Split-Path -Parent $PSScriptRoot)) 'server-network-permanent-fix.log'

try {
  "$(Get-Date -Format s) Starting permanent network fix" | Set-Content -LiteralPath $logFile

  & netsh.exe interface ipv4 set address name="$InterfaceAlias" source=static address="$IpAddress" mask="255.255.255.0" gateway="$Gateway" store=persistent | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'netsh failed to set the static IPv4 address.' }

  Set-DnsClientServerAddress -InterfaceAlias $InterfaceAlias -ServerAddresses @($Gateway)
  Set-NetConnectionProfile -InterfaceAlias $InterfaceAlias -NetworkCategory Private -ErrorAction SilentlyContinue
  Set-NetAdapterPowerManagement -Name $InterfaceAlias -SelectiveSuspend Disabled -DeviceSleepOnDisconnect Disabled -NoRestart -ErrorAction SilentlyContinue

  foreach ($port in @(3000, 5000)) {
    $name = "Badizo POS TCP $port"
    if (!(Get-NetFirewallRule -DisplayName $name -ErrorAction SilentlyContinue)) {
      New-NetFirewallRule -DisplayName $name -Direction Inbound -Protocol TCP -LocalPort $port -Action Allow -Profile Any | Out-Null
    }
  }

  $state = Get-NetIPInterface -InterfaceAlias $InterfaceAlias -AddressFamily IPv4
  if ($state.Dhcp -ne 'Disabled') { throw "DHCP is still $($state.Dhcp)." }

  "$(Get-Date -Format s) SUCCESS IP=$IpAddress DHCP=$($state.Dhcp)" | Add-Content -LiteralPath $logFile
  exit 0
} catch {
  "$(Get-Date -Format s) FAILED $($_.Exception.Message)" | Add-Content -LiteralPath $logFile
  exit 1
}
