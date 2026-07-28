$ErrorActionPreference = 'Stop'

$serverIp = '192.168.1.10'
$prefixLength = 24
$gateway = '192.168.1.1'
$appRoot = $null
$candidateRoot = $PSScriptRoot
for ($level = 0; $level -lt 5 -and $candidateRoot; $level++) {
  if ((Test-Path -LiteralPath (Join-Path $candidateRoot 'backend\server.js')) -and
      (Test-Path -LiteralPath (Join-Path $candidateRoot 'scripts\windows\start-backend.ps1'))) {
    $appRoot = $candidateRoot
    break
  }
  $candidateRoot = Split-Path -Parent $candidateRoot
}
if (!$appRoot) {
  throw 'Badizo application folder was not found. Keep the extracted LAN setup folder anywhere inside D:\badizo-pos-main, then run this setup again.'
}
$startScript = Join-Path $appRoot 'scripts\windows\start-backend.ps1'
$logPath = Join-Path $appRoot 'badizo-lan-only-setup.log'

function Write-Step([string]$Message) {
  Write-Host ''
  Write-Host "== $Message ==" -ForegroundColor Cyan
}

function Get-LanAdapter {
  $adapters = @(Get-NetAdapter -Physical -ErrorAction Stop |
    Where-Object { $_.Status -eq 'Up' -and $_.HardwareInterface } |
    Sort-Object @{ Expression = { if ($_.Name -match 'Ethernet') { 0 } else { 1 } } }, ifIndex)
  if (!$adapters.Count) {
    throw 'No active Ethernet/Wi-Fi LAN adapter was found. Connect this server to the LAN router/switch first.'
  }
  return $adapters[0]
}

function Wait-Badizo {
  for ($attempt = 1; $attempt -le 60; $attempt++) {
    try {
      $response = Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:5000/api/health' -TimeoutSec 2
      if ($response.StatusCode -eq 200) { return $true }
    } catch {}
    Start-Sleep -Seconds 1
  }
  return $false
}

try {
  "$(Get-Date -Format s) starting" | Set-Content -LiteralPath $logPath

  Write-Step 'Selecting the local network adapter'
  $adapter = Get-LanAdapter
  Write-Host "Using adapter: $($adapter.Name)" -ForegroundColor Green

  Write-Step 'Assigning permanent server address 192.168.1.10'
  Set-NetIPInterface -InterfaceIndex $adapter.ifIndex -AddressFamily IPv4 -Dhcp Disabled -ErrorAction Stop
  Get-NetIPAddress -InterfaceIndex $adapter.ifIndex -AddressFamily IPv4 -ErrorAction SilentlyContinue |
    Where-Object { $_.IPAddress -ne $serverIp -and $_.PrefixOrigin -ne 'WellKnown' } |
    Remove-NetIPAddress -Confirm:$false -ErrorAction SilentlyContinue
  if (!(Get-NetIPAddress -InterfaceIndex $adapter.ifIndex -AddressFamily IPv4 -IPAddress $serverIp -ErrorAction SilentlyContinue)) {
    New-NetIPAddress -InterfaceIndex $adapter.ifIndex -IPAddress $serverIp -PrefixLength $prefixLength -ErrorAction Stop | Out-Null
  }
  if (!(Get-NetRoute -InterfaceIndex $adapter.ifIndex -AddressFamily IPv4 -DestinationPrefix '0.0.0.0/0' -ErrorAction SilentlyContinue)) {
    New-NetRoute -InterfaceIndex $adapter.ifIndex -AddressFamily IPv4 -DestinationPrefix '0.0.0.0/0' -NextHop $gateway -RouteMetric 10 -ErrorAction SilentlyContinue | Out-Null
  }
  Set-DnsClientServerAddress -InterfaceIndex $adapter.ifIndex -ServerAddresses @($gateway) -ErrorAction SilentlyContinue
  Set-NetConnectionProfile -InterfaceIndex $adapter.ifIndex -NetworkCategory Private -ErrorAction SilentlyContinue
  Set-NetAdapterPowerManagement -Name $adapter.Name -SelectiveSuspend Disabled -DeviceSleepOnDisconnect Disabled -NoRestart -ErrorAction SilentlyContinue

  Write-Step 'Opening Badizo LAN firewall ports'
  foreach ($port in @(5000, 3000)) {
    $ruleName = "Badizo POS LAN TCP $port"
    Get-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue | Remove-NetFirewallRule -ErrorAction SilentlyContinue
    New-NetFirewallRule -DisplayName $ruleName -Direction Inbound -Action Allow -Protocol TCP -LocalPort $port -Profile Any -RemoteAddress LocalSubnet | Out-Null
  }

  Write-Step 'Installing automatic Badizo server startup'
  if (!(Test-Path -LiteralPath $startScript)) { throw "Missing startup script: $startScript" }
  $taskName = 'Badizo POS Backend'
  $powerShellExe = "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe"
  $action = New-ScheduledTaskAction -Execute $powerShellExe -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$startScript`""
  $trigger = New-ScheduledTaskTrigger -AtStartup
  $principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
  $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Hours 0) -RestartCount 10 -RestartInterval (New-TimeSpan -Minutes 1)
  Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Description 'Runs Badizo POS on the shop LAN without internet.' -Force | Out-Null
  Get-NetTCPConnection -LocalPort 5000 -State Listen -ErrorAction SilentlyContinue |
    Select-Object -ExpandProperty OwningProcess -Unique |
    ForEach-Object { Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue }
  Start-Sleep -Seconds 2
  Start-ScheduledTask -TaskName $taskName

  Write-Step 'Testing the local Badizo application'
  if (!(Wait-Badizo)) {
    throw 'Port 5000 did not become ready. Confirm that MySQL is running, then check backend-startup.log.'
  }
  $lanTest = Invoke-WebRequest -UseBasicParsing -Uri "http://${serverIp}:5000/api/health" -TimeoutSec 5
  if ($lanTest.StatusCode -ne 200) { throw 'Badizo answered locally but not on the LAN address.' }

  "$(Get-Date -Format s) success adapter=$($adapter.Name) ip=$serverIp" | Add-Content -LiteralPath $logPath
  Write-Host ''
  Write-Host 'BADIZO LAN-ONLY SERVER IS READY' -ForegroundColor Green
  Write-Host "App:    http://${serverIp}:5000"
  Write-Host "Health: http://${serverIp}:5000/api/health"
} catch {
  "$(Get-Date -Format s) failed $($_.Exception.Message)" | Add-Content -LiteralPath $logPath
  Write-Host ''
  Write-Host $_.Exception.Message -ForegroundColor Red
  exit 1
}
