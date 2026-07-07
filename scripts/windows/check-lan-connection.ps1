param(
  [string]$ServerHost = '192.168.1.9',
  [int]$Count = 20,
  [int]$DelaySeconds = 2
)

$ErrorActionPreference = 'Continue'

function Test-Url {
  param([string]$Url)

  $started = Get-Date
  try {
    $response = Invoke-WebRequest -UseBasicParsing -Uri $Url -TimeoutSec 5
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

Write-Host 'Badizo LAN connection check' -ForegroundColor Green
Write-Host "Server: $ServerHost"
Write-Host "Frontend: http://${ServerHost}:3000"
Write-Host "Backend:  http://${ServerHost}:5000/api/health"
Write-Host ''

for ($i = 1; $i -le $Count; $i++) {
  $time = Get-Date -Format 'HH:mm:ss'
  $frontend = Test-Url -Url "http://${ServerHost}:3000"
  $backend = Test-Url -Url "http://${ServerHost}:5000/api/health"
  Write-Host "[$time] Test $i/$Count  Frontend=$frontend  Backend=$backend"

  if ($i -lt $Count) {
    Start-Sleep -Seconds $DelaySeconds
  }
}

Write-Host ''
Write-Host 'If any line shows FAIL while other POS works, check this server IP reservation, Windows sleep/power saving, and Badizo scheduled tasks.' -ForegroundColor Yellow
