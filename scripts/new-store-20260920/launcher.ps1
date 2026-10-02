param([ValidateSet('menu','server','admin','counter','security','payroll','check')][string]$Mode='menu')
$ErrorActionPreference = 'Stop'
$payload = $PSScriptRoot
function Read-Server {
  $name = '192.168.1.10'
  $url = 'http://' + $name + ':5000'
  $reply = Invoke-RestMethod -Uri ($url+'/api/health') -TimeoutSec 8
  if (!$reply.ok) { throw 'The selected server is not ready.' }
  $page = Invoke-WebRequest -UseBasicParsing -Uri ($url+'/') -TimeoutSec 8
  if ($page.Content -notmatch '<div id="root">') { throw 'Server UI is not ready.' }
  return $name
}
try {
  & (Join-Path $payload 'verify-package.ps1')
  if ($Mode -eq 'menu') {
    Write-Host 'BADIZO NEW STORE - 20 September 2026'
    Write-Host '1 SERVER (first)    2 ADMIN    3 COUNTER'
    Write-Host '4 SECURITY         5 STAFF/PAYROLL (Admin access)'
    Write-Host '6 CHECK connection/printers    Q Exit'
    switch ((Read-Host 'Select').Trim().ToUpper()) {
      '1' {$Mode='server'} '2' {$Mode='admin'} '3' {$Mode='counter'}
      '4' {$Mode='security'} '5' {$Mode='payroll'} '6' {$Mode='check'} 'Q' {exit 0}
      default {throw 'Choose 1 to 6.'}
    }
  }
  if ($Mode -eq 'server') {
    $argsText = '-NoProfile -ExecutionPolicy Bypass -File "{0}"' -f (Join-Path $payload 'install-server.ps1')
    $p = Start-Process -Verb RunAs -FilePath "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" -ArgumentList $argsText -Wait -PassThru
    if ($p.ExitCode -ne 0) { throw 'Server setup failed. See C:\BadizoPOS\installation.log. No client setup was started.' }
    $serverName = '192.168.1.10'
    $loginMode='server'; $loginUser='server'
  } else {
    $serverName = Read-Server
    switch ($Mode) {
      'admin' {
        $loginUser = (Read-Host 'Login user [admin / admin1 / admin2], default admin').Trim().ToLower()
        if (!$loginUser) {$loginUser='admin'}
        if ($loginUser -notin @('admin','admin1','admin2')) {throw 'Select admin, admin1 or admin2.'}
        $loginMode='admin'
      }
      'counter' {
        $number = (Read-Host 'System number (1 to 6)').Trim()
        if ($number -notmatch '^[1-6]$') {throw 'System number must be 1 to 6.'}
        $loginMode='counter'; $loginUser="counter$number"
      }
      'security' {$loginMode='security'; $loginUser='security'}
      'payroll' {
        $loginMode='admin'; $loginUser='admin'
        Write-Host 'Staff Payroll is inside POS. Sign in as Admin, then open Staff Payroll.'
      }
      'check' {
        Write-Host ('SERVER + UI OK: http://' + $serverName + ':5000') -ForegroundColor Green
        Get-Printer | Select-Object Name,DriverName,PortName,PrinterStatus | Format-Table -AutoSize
        Write-Host 'Listing printers does not send a test print. Follow the PDF commissioning checklist.'
        Read-Host 'Press Enter to close' | Out-Null
        exit 0
      }
    }
  }
  $clientArgs = '-NoProfile -ExecutionPolicy Bypass -File "{0}" -ServerIp "{1}" -ServerHosts "{1}" -LoginMode "{2}" -LoginUser "{3}" -InstallerPath "{4}" -SkipServerCheck -SkipLaunch' -f (Join-Path $payload 'setup-slave-app.ps1'),$serverName,$loginMode,$loginUser,(Join-Path $payload 'Badizo Setup 1.0.0.exe')
  $client = Start-Process -FilePath "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" -ArgumentList $clientArgs -Wait -PassThru -WindowStyle Hidden
  if ($client.ExitCode -ne 0) {throw 'Desktop app install failed. Rerun this BAT and inspect installer logs.'}
  Write-Host 'READY: open Badizo POS on the Desktop.' -ForegroundColor Green
  if ($Mode -eq 'payroll') {
    $desktop = [Environment]::GetFolderPath('Desktop')
    $original = Join-Path $desktop 'Badizo POS.lnk'
    if (Test-Path $original) {Copy-Item $original (Join-Path $desktop 'Badizo Staff Payroll.lnk') -Force}
    Write-Host 'Payroll shortcut opens Admin login; choose Staff Payroll after login.'
  }
} catch {
  Write-Host ('SETUP FAILED: ' + $_.Exception.Message) -ForegroundColor Red
  Read-Host 'Press Enter to close' | Out-Null
  exit 1
}
Read-Host 'Press Enter to close' | Out-Null
