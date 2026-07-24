param(
  [ValidateSet('all', 'admin', 'counter', 'security')]
  [string]$LoginMode = 'all',
  [string]$LoginUser = '',
  [switch]$TestOnly
)

$ErrorActionPreference = 'Stop'
$server = '192.168.1.10'
$baseUrl = "http://${server}:5000"

try {
  $response = Invoke-WebRequest -UseBasicParsing -Uri "${baseUrl}/api/health" -TimeoutSec 4
  if ($response.StatusCode -ne 200) { throw 'Health check did not return OK.' }
  if ($TestOnly) {
    Write-Host 'SUCCESS: Badizo server is available on this LAN.' -ForegroundColor Green
    Write-Host "Open: $baseUrl"
    Read-Host 'Press Enter to close'
    exit 0
  }

  $url = "${baseUrl}?loginMode=$([uri]::EscapeDataString($LoginMode))"
  if ($LoginUser) { $url += "&loginUser=$([uri]::EscapeDataString($LoginUser))" }
  Start-Process $url
} catch {
  Add-Type -AssemblyName PresentationFramework
  [System.Windows.MessageBox]::Show(
    "Badizo server is not available on the local LAN.`n`nCheck:`n1. Server PC is ON`n2. LAN router/switch is ON`n3. Ethernet/Wi-Fi LAN is connected`n4. Server address is 192.168.1.10`n`nInternet is NOT required.",
    'Badizo LAN Connection',
    'OK',
    'Error'
  ) | Out-Null
  exit 1
}
