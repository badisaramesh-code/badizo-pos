param(
  [string]$InterfaceAlias = '',
  [string]$LegacyIp = '192.168.1.14',
  [int]$PrefixLength = 24,
  [switch]$SkipLegacyIp
)

$ErrorActionPreference = 'Stop'

function Write-Step {
  param([string]$Message)
  Write-Host ''
  Write-Host "== $Message ==" -ForegroundColor Cyan
}

function Assert-Administrator {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = New-Object Security.Principal.WindowsPrincipal($identity)
  if (!$principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw 'Run this script as Administrator.'
  }
}

function Resolve-ServerAdapter {
  if (![string]::IsNullOrWhiteSpace($InterfaceAlias)) {
    $adapter = Get-NetAdapter -Name $InterfaceAlias -ErrorAction Stop
    if ($adapter.Status -ne 'Up') {
      throw "Network adapter '$InterfaceAlias' is not Up."
    }
    return $adapter.Name
  }

  $adapter = Get-NetAdapter -Physical -ErrorAction SilentlyContinue |
    Where-Object { $_.Status -eq 'Up' } |
    Sort-Object InterfaceMetric |
    Select-Object -First 1

  if (!$adapter) {
    throw 'No active physical network adapter was found.'
  }

  return $adapter.Name
}

function Get-AdapterIps {
  param([string]$AdapterName)
  @(Get-NetIPAddress -InterfaceAlias $AdapterName -AddressFamily IPv4 -ErrorAction SilentlyContinue |
    Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' })
}

function Test-HttpOk {
  param([string]$Url, [int]$TimeoutSec = 5)
  try {
    $response = Invoke-WebRequest -UseBasicParsing -Uri $Url -TimeoutSec $TimeoutSec
    return ($response.StatusCode -ge 200 -and $response.StatusCode -lt 400)
  } catch {
    return $false
  }
}

function Test-HostReplies {
  param([string]$HostName)
  try {
    return Test-Connection -ComputerName $HostName -Count 1 -Quiet -ErrorAction SilentlyContinue
  } catch {
    return $false
  }
}

function Add-FirewallRuleIfMissing {
  param([string]$DisplayName, [int]$Port)
  $existing = Get-NetFirewallRule -DisplayName $DisplayName -ErrorAction SilentlyContinue
  if ($existing) {
    Write-Host "Firewall rule already exists: $DisplayName" -ForegroundColor Yellow
    return
  }

  New-NetFirewallRule -DisplayName $DisplayName -Direction Inbound -Protocol TCP -LocalPort $Port -Action Allow | Out-Null
  Write-Host "Firewall rule added: $DisplayName" -ForegroundColor Green
}

function Ensure-LegacyIpOnServer {
  param([string]$AdapterName)

  if ($SkipLegacyIp -or [string]::IsNullOrWhiteSpace($LegacyIp)) {
    return $false
  }

  $adapterIps = Get-AdapterIps -AdapterName $AdapterName
  if ($adapterIps.IPAddress -contains $LegacyIp) {
    Write-Host "Legacy IP already belongs to this server: $LegacyIp" -ForegroundColor Green
    return $true
  }

  if (Test-HostReplies -HostName $LegacyIp) {
    Write-Host "IP conflict: $LegacyIp replies on the LAN but is not assigned to this server." -ForegroundColor Red
    Write-Host "Do not add this IP until the other device/router reservation is removed." -ForegroundColor Red
    return $false
  }

  New-NetIPAddress -InterfaceAlias $AdapterName -IPAddress $LegacyIp -PrefixLength $PrefixLength -ErrorAction Stop | Out-Null
  Write-Host "Added legacy server IP alias: $LegacyIp/$PrefixLength" -ForegroundColor Green
  return $true
}

function Install-And-StartBackend {
  $scriptRoot = $PSScriptRoot
  $backendTaskScript = Join-Path $scriptRoot 'install-backend-startup-task.ps1'
  if (!(Test-Path $backendTaskScript)) {
    throw "Missing backend startup task script: $backendTaskScript"
  }

  & $backendTaskScript
  Start-ScheduledTask -TaskName 'Badizo POS Backend' -ErrorAction SilentlyContinue
  Start-Sleep -Seconds 5
}

function Restart-ServerScript {
  $appRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
  $startScript = Join-Path $appRoot 'START_BADIZO_SERVER.bat'
  if (Test-Path $startScript) {
    Start-Process -FilePath $startScript -WorkingDirectory $appRoot
    Start-Sleep -Seconds 8
  }
}

Assert-Administrator

Write-Host 'Badizo server distribution permanent fix' -ForegroundColor Green

Write-Step 'Detecting server adapter'
$adapterName = Resolve-ServerAdapter
$currentIps = Get-AdapterIps -AdapterName $adapterName
Write-Host "Adapter: $adapterName"
Write-Host "Current server IPs: $($currentIps.IPAddress -join ', ')"

Write-Step 'Opening firewall port 5000'
Add-FirewallRuleIfMissing -DisplayName 'Badizo POS Backend 5000' -Port 5000

Write-Step 'Adding old client IP to this server if safe'
$legacyAddedOrOwned = Ensure-LegacyIpOnServer -AdapterName $adapterName

Write-Step 'Installing and starting server distribution'
Install-And-StartBackend
Restart-ServerScript

Write-Step 'Final distribution checks'
$checkIps = @($currentIps.IPAddress)
if ($legacyAddedOrOwned) {
  $checkIps += $LegacyIp
}
$checkIps = @($checkIps | Where-Object { ![string]::IsNullOrWhiteSpace($_) } | Select-Object -Unique)

$allOk = $true
foreach ($ip in $checkIps) {
  $appOk = Test-HttpOk -Url "http://${ip}:5000"
  $healthOk = Test-HttpOk -Url "http://${ip}:5000/api/health"
  Write-Host "http://${ip}:5000 app=$appOk health=$healthOk"
  if (!$appOk -or !$healthOk) {
    $allOk = $false
  }
}

if (!$allOk) {
  throw 'Server distribution is still not healthy on all expected IPs. Check MySQL/backend log and Windows Firewall.'
}

if (!$legacyAddedOrOwned -and !$SkipLegacyIp) {
  Write-Host ''
  Write-Host "Server is healthy on current IP, but old IP $LegacyIp is owned by another device or unavailable." -ForegroundColor Yellow
  Write-Host "Counter2 cannot open old $LegacyIp until that network conflict is fixed or Counter2 config is updated." -ForegroundColor Yellow
}

Write-Host ''
Write-Host 'Server distribution fixed. Use port 5000 for Badizo app and API.' -ForegroundColor Green
Write-Host 'Press Enter to close this window.'
Read-Host | Out-Null
