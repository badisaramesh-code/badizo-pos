param([string]$InstallRoot='C:\BadizoPOS')
$ErrorActionPreference='Stop'
$target='192.168.1.10'
$existing=@(Get-NetIPAddress -AddressFamily IPv4 -IPAddress $target -ErrorAction SilentlyContinue)
if ($existing.Count) {
 if ($existing[0].PrefixLength -ne 24 -or $existing[0].AddressState -eq 'Duplicate') {throw 'Existing 192.168.1.10 must be unique with subnet mask 255.255.255.0.'}
 $index=$existing[0].InterfaceIndex
} else {
 $adapters=@(Get-NetAdapter -Physical | Where-Object Status -eq 'Up')
 if (!$adapters.Count) {throw 'Connect the server LAN cable and retry.'}
 if ($adapters.Count -eq 1) {$index=$adapters[0].ifIndex} else {
  $adapters | Format-Table ifIndex,Name,InterfaceDescription
  $choice=Read-Host 'Enter the interface index of the SHOP LAN adapter'
  if ($choice -notmatch '^\d+$' -or [int]$choice -notin $adapters.ifIndex) {throw 'Invalid LAN adapter selection.'}
  $index=[int]$choice
 }
 if (Test-Connection $target -Count 2 -Quiet) {throw '192.168.1.10 already responds. Disconnect the conflicting device or assign it another IP.'}
 $old=Get-NetIPConfiguration -InterfaceIndex $index
 $old | Export-Clixml (Join-Path $InstallRoot 'network-before-install.xml')
 $gateway=@($old.IPv4DefaultGateway | Select-Object -ExpandProperty NextHop | Where-Object {$_ -like '192.168.1.*' -and $_ -ne $target})
 Set-NetIPInterface -InterfaceIndex $index -AddressFamily IPv4 -Dhcp Disabled
 Get-NetIPAddress -InterfaceIndex $index -AddressFamily IPv4 | Where-Object PrefixOrigin -ne 'WellKnown' | Remove-NetIPAddress -Confirm:$false
 Get-NetRoute -InterfaceIndex $index -AddressFamily IPv4 -DestinationPrefix '0.0.0.0/0' -ErrorAction SilentlyContinue | Remove-NetRoute -Confirm:$false
 $params=@{InterfaceIndex=$index;IPAddress=$target;PrefixLength=24}
 if ($gateway.Count) {$params.DefaultGateway=$gateway[0]}
 New-NetIPAddress @params | Out-Null
 Start-Sleep -Seconds 3
}
$address=Get-NetIPAddress -InterfaceIndex $index -IPAddress $target
if ($address.AddressState -ne 'Preferred') {throw 'Static IP is not ready or conflicts with another device. Review Windows network settings.'}
Get-NetConnectionProfile -InterfaceIndex $index -ErrorAction SilentlyContinue | Where-Object NetworkCategory -ne 'DomainAuthenticated' | Set-NetConnectionProfile -NetworkCategory Private
Write-Host 'SHOP LAN server: 192.168.1.10 / 255.255.255.0. Exclude .10 from router DHCP pool.'
