param(
  [string]$InterfaceAlias = 'Ethernet',
  [string]$TargetIp = '',
  [int]$PrefixLength = 24,
  [string]$Gateway = '192.168.1.1',
  [string[]]$DnsServers = @('192.168.1.1'),
  [switch]$SkipStaticIp
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

function Test-BadizoUrl {
  param([string]$Url, [int]$TimeoutSec = 5)
  try {
    $response = Invoke-WebRequest -UseBasicParsing -Uri $Url -TimeoutSec $TimeoutSec
    return ($response.StatusCode -ge 200 -and $response.StatusCode -lt 400)
  } catch {
    return $false
  }
}

function Resolve-TargetIp {
  if (![string]::IsNullOrWhiteSpace($TargetIp)) {
    return $TargetIp.Trim()
  }

  $currentIp = Get-NetIPAddress -InterfaceAlias $InterfaceAlias -AddressFamily IPv4 -ErrorAction SilentlyContinue |
    Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' } |
    Select-Object -First 1 -ExpandProperty IPAddress

  if ([string]::IsNullOrWhiteSpace($currentIp)) {
    throw "Unable to auto-detect server IP on adapter '$InterfaceAlias'. Run again with -TargetIp 192.168.x.x"
  }

  return $currentIp
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

function Set-ServerStaticIp {
  $adapter = Get-NetAdapter -Name $InterfaceAlias -ErrorAction Stop
  if ($adapter.Status -ne 'Up') {
    throw "Network adapter '$InterfaceAlias' is not Up. Current status: $($adapter.Status)"
  }

  $currentAddresses = @(Get-NetIPAddress -InterfaceAlias $InterfaceAlias -AddressFamily IPv4 -ErrorAction SilentlyContinue |
    Where-Object { $_.IPAddress -notlike '169.254.*' })

  if ($currentAddresses.IPAddress -contains $TargetIp) {
    Write-Host "Server already has static/active IP: $TargetIp" -ForegroundColor Green
  } else {
    Write-Host "Setting $InterfaceAlias to static IP $TargetIp/$PrefixLength gateway $Gateway" -ForegroundColor Yellow

    foreach ($address in $currentAddresses) {
      Remove-NetIPAddress -InterfaceAlias $InterfaceAlias -IPAddress $address.IPAddress -Confirm:$false -ErrorAction SilentlyContinue
    }

    Get-NetRoute -InterfaceAlias $InterfaceAlias -DestinationPrefix '0.0.0.0/0' -ErrorAction SilentlyContinue |
      Remove-NetRoute -Confirm:$false -ErrorAction SilentlyContinue

    New-NetIPAddress -InterfaceAlias $InterfaceAlias -IPAddress $TargetIp -PrefixLength $PrefixLength -DefaultGateway $Gateway | Out-Null
  }

  Set-DnsClientServerAddress -InterfaceAlias $InterfaceAlias -ServerAddresses $DnsServers

  try {
    Set-NetConnectionProfile -InterfaceAlias $InterfaceAlias -NetworkCategory Private
  } catch {
    Write-Host 'Could not set network profile to Private. Continuing.' -ForegroundColor Yellow
  }

  Write-Host "IP fixed: $TargetIp" -ForegroundColor Green
}

function Ensure-MySql {
  $service = Get-Service -Name MySQL80 -ErrorAction SilentlyContinue
  if (!$service) {
    throw 'MySQL80 service was not found on this server.'
  }

  Set-Service -Name MySQL80 -StartupType Automatic
  if ($service.Status -ne 'Running') {
    Start-Service -Name MySQL80
  }
  Write-Host 'MySQL80 is Automatic and Running.' -ForegroundColor Green
}

function Restart-BadizoServer {
  $appRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
  $startScript = Join-Path $appRoot 'START_BADIZO_SERVER.bat'
  if (!(Test-Path $startScript)) {
    throw "Missing server start script: $startScript"
  }

  $ports = @(3000, 5000)
  foreach ($port in $ports) {
    Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue |
      ForEach-Object {
        try {
          Stop-Process -Id $_.OwningProcess -Force -ErrorAction Stop
          Write-Host "Stopped PID $($_.OwningProcess) on port $port"
        } catch {}
      }
  }

  Start-ScheduledTask -TaskName 'Badizo POS Backend' -ErrorAction SilentlyContinue

  Start-Process -FilePath $startScript -WorkingDirectory $appRoot
}

function Wait-ForBadizo {
  foreach ($url in @("http://${TargetIp}:5000/api/health", "http://${TargetIp}:5000")) {
    $ok = $false
    for ($i = 1; $i -le 60; $i++) {
      if (Test-BadizoUrl -Url $url -TimeoutSec 3) {
        $ok = $true
        break
      }
      Start-Sleep -Seconds 1
    }

    if ($ok) {
      Write-Host "OK: $url" -ForegroundColor Green
    } else {
      throw "Badizo check failed: $url"
    }
  }
}

Assert-Administrator

$TargetIp = Resolve-TargetIp

Write-Host 'Badizo server permanent network/startup fix' -ForegroundColor Green
Write-Host "Target server IP: $TargetIp"

if (!$SkipStaticIp) {
  Write-Step 'Fixing server IP'
  Set-ServerStaticIp
} else {
  Write-Step 'Skipping static IP change'
}

Write-Step 'Checking MySQL'
Ensure-MySql

Write-Step 'Opening firewall ports'
Add-FirewallRuleIfMissing -DisplayName 'Badizo POS Backend 5000' -Port 5000

Write-Step 'Installing startup tasks'
& (Join-Path $PSScriptRoot 'install-backend-startup-task.ps1')

Write-Step 'Restarting Badizo'
Restart-BadizoServer

Write-Step 'Verifying server URLs'
Wait-ForBadizo

Write-Host ''
Write-Host "Server fixed. Counters/admin should use http://${TargetIp}:5000" -ForegroundColor Green
