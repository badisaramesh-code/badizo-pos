param(
  [string]$ReportDirectory = $PSScriptRoot,
  [switch]$VerifyOnly
)
$ErrorActionPreference = 'Stop'
try {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = New-Object Security.Principal.WindowsPrincipal($identity)
  if (!$VerifyOnly -and !$principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    $arguments = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ('"' + $PSCommandPath + '"'), '-ReportDirectory', ('"' + $ReportDirectory + '"'))
    $elevated = Start-Process -FilePath powershell.exe -ArgumentList $arguments -Verb RunAs -WindowStyle Hidden -Wait -PassThru
    exit $elevated.ExitCode
  }
  $database = Get-Service -Name MySQL80 -ErrorAction Stop
  $pos = Get-Service -Name BadizoServer -ErrorAction Stop
  New-Item -ItemType Directory -Force -Path $ReportDirectory | Out-Null
  if (!$VerifyOnly) {
    $before = Join-Path $ReportDirectory 'mysql-recovery-before.txt'
    if (!(Test-Path -LiteralPath $before)) { sc.exe qfailure MySQL80 | Out-File -LiteralPath $before -Encoding UTF8 }
    sc.exe failure MySQL80 reset= 86400 actions= restart/5000/restart/15000/restart/60000
    if ($LASTEXITCODE -ne 0) { throw 'Windows did not apply MySQL automatic recovery.' }
  }
  $recovery = sc.exe qfailure MySQL80 | Out-String
  if ($LASTEXITCODE -ne 0) { throw 'Unable to verify MySQL recovery.' }
  $health = Invoke-RestMethod -Uri http://127.0.0.1:5000/api/health -TimeoutSec 5
  $result = [ordered]@{
    checkedAt = (Get-Date -Format o)
    applied = !$VerifyOnly
    mysqlRunning = (Get-Service MySQL80).Status -eq 'Running'
    posRunning = (Get-Service BadizoServer).Status -eq 'Running'
    healthOk = $health.ok -eq $true
    mysqlRecovery = $recovery
  }
  $result | ConvertTo-Json -Depth 3 | Set-Content -LiteralPath (Join-Path $ReportDirectory 'server-recovery-result.json') -Encoding UTF8
  if (!$VerifyOnly -and ($recovery -notmatch '5000' -or $recovery -notmatch '15000' -or $recovery -notmatch '60000')) { throw 'MySQL recovery read-back verification failed. Check server-recovery-result.json.' }
  if (!$result.mysqlRunning -or !$result.posRunning -or !$result.healthOk) { throw 'A server service or health check is unavailable. See server-recovery-result.json.' }
  Write-Host 'Server and database are healthy. Recovery settings checked; no service restart was performed.' -ForegroundColor Green
} catch {
  Write-Host $_.Exception.Message -ForegroundColor Red
  exit 1
}
