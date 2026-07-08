param(
  [string]$ServerHost = '',
  [int]$Count = 20,
  [int]$DelaySeconds = 2
)

$ErrorActionPreference = 'Continue'

function Test-Url {
  param([string]$Url, [int]$TimeoutSec = 5)

  $started = Get-Date
  try {
    $response = Invoke-WebRequest -UseBasicParsing -Uri $Url -TimeoutSec $TimeoutSec
    $elapsed = [math]::Round(((Get-Date) - $started).TotalMilliseconds)
    if ($response.StatusCode -ge 200 -and $response.StatusCode -lt 400) {
      return "OK ${elapsed}ms"
    }
    return "HTTP $($response.StatusCode) ${elapsed}ms"
  } catch {
    $elapsed = [math]::Round(((Get-Date) - $started).TotalMilliseconds)
    return "FAIL ${elapsed}ms $($_.Exception.Message)"
  }
}

function Resolve-BadizoServer {
  foreach ($hostName in @($ServerHost, 'badizo-server.local', 'badizo-server', 'server', 'SERVER')) {
    if ([string]::IsNullOrWhiteSpace($hostName)) { continue }
    if ((Test-Url -Url "http://${hostName}:5000/api/health" -TimeoutSec 2) -like 'OK*') {
      return $hostName
    }
  }

  $ips = @(Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
    Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' -and $_.PrefixOrigin -ne 'WellKnown' } |
    Select-Object -ExpandProperty IPAddress)
  foreach ($ip in $ips) {
    $parts = $ip.Split('.')
    if ($parts.Count -ne 4) { continue }
    for ($last = 1; $last -le 254; $last++) {
      $candidate = "$($parts[0]).$($parts[1]).$($parts[2]).$last"
      if ((Test-Url -Url "http://${candidate}:5000/api/health" -TimeoutSec 1) -like 'OK*') {
        return $candidate
      }
    }
  }

  return ''
}

$ServerHost = Resolve-BadizoServer
if ([string]::IsNullOrWhiteSpace($ServerHost)) {
  Write-Host 'Badizo server was not found on this LAN.' -ForegroundColor Red
  exit 1
}

Write-Host 'Badizo LAN connection check' -ForegroundColor Green
Write-Host "Server: $ServerHost"
Write-Host "Badizo app: http://${ServerHost}:5000"
Write-Host "Backend:    http://${ServerHost}:5000/api/health"
Write-Host ''

for ($i = 1; $i -le $Count; $i++) {
  $time = Get-Date -Format 'HH:mm:ss'
  $frontend = Test-Url -Url "http://${ServerHost}:5000"
  $backend = Test-Url -Url "http://${ServerHost}:5000/api/health"
  Write-Host "[$time] Test $i/$Count  Frontend=$frontend  Backend=$backend"

  if ($i -lt $Count) {
    Start-Sleep -Seconds $DelaySeconds
  }
}

Write-Host ''
Write-Host 'If any line shows FAIL while other POS works, check this server IP reservation, Windows sleep/power saving, and Badizo scheduled tasks.' -ForegroundColor Yellow
