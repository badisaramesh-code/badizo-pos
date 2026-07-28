$ErrorActionPreference = 'Stop'

$appRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$backendDir = Join-Path $appRoot 'backend'
$nodeExe = 'C:\Program Files\nodejs\node.exe'
$resultPath = Join-Path $appRoot 'backend-restart-result.txt'

if (!(Test-Path -LiteralPath $nodeExe)) {
  $nodeExe = (Get-Command node.exe -ErrorAction Stop).Source
}

$listeners = Get-NetTCPConnection -LocalPort 5000 -State Listen -ErrorAction SilentlyContinue
foreach ($listener in $listeners) {
  Stop-Process -Id $listener.OwningProcess -Force -ErrorAction Stop
}

Start-Sleep -Seconds 2
Start-Process -FilePath $nodeExe -ArgumentList 'server.js' -WorkingDirectory $backendDir -WindowStyle Hidden

$ready = $false
for ($attempt = 1; $attempt -le 45; $attempt += 1) {
  Start-Sleep -Seconds 1
  try {
    $response = Invoke-WebRequest -UseBasicParsing 'http://localhost:5000/api/health' -TimeoutSec 3
    if ($response.StatusCode -eq 200) {
      $ready = $true
      break
    }
  } catch {}
}

if (!$ready) {
  "$(Get-Date -Format s) FAILED backend health" | Set-Content -LiteralPath $resultPath
  throw 'Badizo backend did not become healthy on port 5000.'
}

$newListener = Get-NetTCPConnection -LocalPort 5000 -State Listen -ErrorAction Stop | Select-Object -First 1
"$(Get-Date -Format s) SUCCESS PID=$($newListener.OwningProcess) HEALTH=200" | Set-Content -LiteralPath $resultPath
