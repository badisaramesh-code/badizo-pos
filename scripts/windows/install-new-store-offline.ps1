param(
  [Parameter(Mandatory = $true)][string]$PackageRoot,
  [string]$InstallRoot = 'C:\BadizoPOS'
)

$ErrorActionPreference = 'Stop'
$taskName = 'Badizo POS Backend'
$fixedServerIp = '192.168.1.10'

function Step([string]$Text) {
  Write-Host ''
  Write-Host "== $Text ==" -ForegroundColor Cyan
}

function Require-Admin {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = New-Object Security.Principal.WindowsPrincipal($identity)
  if (!$principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw 'Administrator permission is required.'
  }
}

function Find-MySql {
  $command = Get-Command mysql.exe -ErrorAction SilentlyContinue
  if ($command) { return $command.Source }
  $found = Get-ChildItem 'C:\Program Files\MySQL' -Filter mysql.exe -Recurse -File -ErrorAction SilentlyContinue |
    Sort-Object FullName -Descending | Select-Object -First 1
  if ($found) { return $found.FullName }
  return ''
}

function Set-FixedServerIp([string]$IpAddress) {
  Step "Fixing server IPv4 address to $IpAddress"
  $config = Get-NetIPConfiguration -ErrorAction SilentlyContinue |
    Where-Object { $_.NetAdapter.Status -eq 'Up' -and $_.IPv4DefaultGateway } |
    Select-Object -First 1
  if (!$config) { throw 'No active LAN adapter with a default gateway was found. Connect the server by LAN cable and run again.' }
  $index = $config.InterfaceIndex
  $gateway = $config.IPv4DefaultGateway.NextHop
  $current = @($config.IPv4Address | Where-Object { $_.IPAddress -notlike '169.254.*' }) | Select-Object -First 1
  $prefix = if ($current) { [int]$current.PrefixLength } else { 24 }
  $localIps = @(Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue | Select-Object -ExpandProperty IPAddress)
  if ($localIps -notcontains $IpAddress -and (Test-Connection -ComputerName $IpAddress -Count 1 -Quiet -ErrorAction SilentlyContinue)) {
    throw "$IpAddress is already responding on the LAN. Remove the IP conflict before installation."
  }
  Set-NetIPInterface -InterfaceIndex $index -AddressFamily IPv4 -Dhcp Disabled -ErrorAction Stop
  if ($localIps -notcontains $IpAddress) {
    New-NetIPAddress -InterfaceIndex $index -IPAddress $IpAddress -PrefixLength $prefix -ErrorAction Stop | Out-Null
  }
  Get-NetIPAddress -InterfaceIndex $index -AddressFamily IPv4 -ErrorAction SilentlyContinue |
    Where-Object { $_.IPAddress -ne $IpAddress -and $_.IPAddress -notlike '169.254.*' } |
    Remove-NetIPAddress -Confirm:$false -ErrorAction SilentlyContinue
  if ($gateway -and !(Get-NetRoute -InterfaceIndex $index -AddressFamily IPv4 -DestinationPrefix '0.0.0.0/0' -ErrorAction SilentlyContinue)) {
    New-NetRoute -InterfaceIndex $index -DestinationPrefix '0.0.0.0/0' -NextHop $gateway -RouteMetric 10 | Out-Null
  }
  Set-NetConnectionProfile -InterfaceIndex $index -NetworkCategory Private -ErrorAction SilentlyContinue
  if (!(Get-NetIPAddress -InterfaceIndex $index -AddressFamily IPv4 -IPAddress $IpAddress -ErrorAction SilentlyContinue)) {
    throw "Windows did not retain fixed IP $IpAddress."
  }
  Write-Host "Server fixed IP configured: $IpAddress/$prefix" -ForegroundColor Green
  return $IpAddress
}
function Convert-Secure([Security.SecureString]$Value) {
  $ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($Value)
  try { return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr) }
  finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr) }
}

try {
  Require-Admin
  $PackageRoot = (Resolve-Path -LiteralPath $PackageRoot).Path
  $payload = Join-Path $PackageRoot 'payload'
  foreach ($required in @('app\backend\server.js', 'app\backend\node_modules', 'app\frontend\build\index.html', 'runtime\node.exe')) {
    if (!(Test-Path -LiteralPath (Join-Path $payload $required))) { throw "Package file missing: $required" }
  }

  Step 'Checking MySQL installed at site'
  $mysql = Find-MySql
  if (!$mysql) { throw 'MySQL client was not found. Install and configure MySQL Server 8.x first, then run this BAT again.' }
  $mysqlServices = @(Get-Service -Name 'MySQL*' -ErrorAction SilentlyContinue)
  if (!$mysqlServices.Count) { throw 'MySQL Windows service was not found. Complete MySQL Server configuration first.' }
  foreach ($service in $mysqlServices) {
    Set-Service -Name $service.Name -StartupType Automatic
    if ($service.Status -ne 'Running') { Start-Service -Name $service.Name }
  }

  $dbUser = Read-Host 'MySQL user [root]'
  if ([string]::IsNullOrWhiteSpace($dbUser)) { $dbUser = 'root' }
  $securePassword = Read-Host 'MySQL password' -AsSecureString
  $dbPassword = Convert-Secure $securePassword
  if ([string]::IsNullOrEmpty($dbPassword)) { throw 'MySQL password cannot be blank.' }
  $env:MYSQL_PWD = $dbPassword
  & $mysql "-u$dbUser" -e 'CREATE DATABASE IF NOT EXISTS badizo_pos CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;'
  $mysqlExit = $LASTEXITCODE
  Remove-Item Env:\MYSQL_PWD -ErrorAction SilentlyContinue
  if ($mysqlExit -ne 0) { throw 'MySQL login/database creation failed. Check the username and password.' }

  Step 'Installing Badizo server files'
  New-Item -ItemType Directory -Force -Path $InstallRoot | Out-Null
  Copy-Item -LiteralPath (Join-Path $payload 'app\backend') -Destination $InstallRoot -Recurse -Force
  Copy-Item -LiteralPath (Join-Path $payload 'app\frontend') -Destination $InstallRoot -Recurse -Force
  Copy-Item -LiteralPath (Join-Path $payload 'runtime') -Destination $InstallRoot -Recurse -Force
  New-Item -ItemType Directory -Force -Path (Join-Path $InstallRoot 'backend\logs') | Out-Null

  $serverIp = Set-FixedServerIp -IpAddress $fixedServerIp
  $mysqlDump = Join-Path (Split-Path $mysql) 'mysqldump.exe'
  if (!(Test-Path -LiteralPath $mysqlDump)) { throw 'mysqldump.exe was not found beside mysql.exe.' }
  $backupRoot = if (Test-Path -LiteralPath 'D:\') { 'D:\BadizoPOSBackups' } else { 'C:\BadizoPOSBackups' }
  New-Item -ItemType Directory -Force -Path $backupRoot | Out-Null
  $envLines = @(
    'DB_HOST=localhost',
    "DB_USER=$dbUser",
    "DB_PASSWORD=$dbPassword",
    'DB_NAME=badizo_pos',
    'HOST=0.0.0.0',
    'PORT=5000',
    'BADIZO_LEGACY_FRONTEND_PORT=3000',
    "BACKUP_DIR=$backupRoot",
    'BACKUP_DAILY_TIME=22:30',
    "MYSQLDUMP_PATH=$mysqlDump",
    "MYSQL_PATH=$mysql",
    'GOOGLE_DRIVE_BACKUP_ENABLED=false',
    'GOOGLE_DRIVE_BACKUP_KEEP_COUNT=3',
    'GOOGLE_DRIVE_RETRY_MINUTES=10'
  )
  $envLines | Set-Content -LiteralPath (Join-Path $InstallRoot 'backend\.env') -Encoding UTF8

  $startScript = @'
$ErrorActionPreference = 'Stop'
$root = 'C:\BadizoPOS'
$node = Join-Path $root 'runtime\node.exe'
$backend = Join-Path $root 'backend'
$logDir = Join-Path $backend 'logs'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
Set-Location $backend
& $node 'server.js' >> (Join-Path $logDir 'server.out.log') 2>> (Join-Path $logDir 'server.err.log')
'@
  $startPath = Join-Path $InstallRoot 'start-badizo.ps1'
  $startScript | Set-Content -LiteralPath $startPath -Encoding UTF8

  Step 'Installing auto-start and firewall rules'
  $action = New-ScheduledTaskAction -Execute "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$startPath`""
  $trigger = New-ScheduledTaskTrigger -AtStartup
  $principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
  $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Hours 0) -RestartCount 5 -RestartInterval (New-TimeSpan -Minutes 1)
  Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Description 'Badizo POS server' -Force | Out-Null
  foreach ($port in @(5000, 3000)) {
    $ruleName = "Badizo POS TCP $port"
    if (!(Get-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue)) {
      New-NetFirewallRule -DisplayName $ruleName -Direction Inbound -Protocol TCP -LocalPort $port -Action Allow | Out-Null
    }
  }
  Start-ScheduledTask -TaskName $taskName

  Step 'Final verification'
  $healthy = $false
  for ($i = 1; $i -le 30; $i++) {
    Start-Sleep -Seconds 1
    try {
      $response = Invoke-WebRequest -UseBasicParsing -Uri 'http://localhost:5000/api/health' -TimeoutSec 2
      if ($response.StatusCode -eq 200) { $healthy = $true; break }
    } catch {}
  }
  if (!$healthy) { throw "Server did not become healthy. Check $InstallRoot\backend\logs\server.err.log" }

  Write-Host ''
  Write-Host 'BADIZO SERVER INSTALLATION SUCCESSFUL' -ForegroundColor Green
  Write-Host "Server URL: http://${serverIp}:5000" -ForegroundColor Green
  Write-Host "Health URL: http://${serverIp}:5000/api/health" -ForegroundColor Green
  Write-Host "Local daily backup: $backupRoot at 22:30" -ForegroundColor Green
  Write-Host 'IMPORTANT: Reserve 192.168.1.10 in the router to prevent IP conflicts.' -ForegroundColor Yellow

  Step 'Installing Badizo desktop app with official B shortcut'
  $clientSetup = Join-Path $payload 'setup-slave-app.ps1'
  $desktopInstaller = Join-Path $payload 'Badizo Setup 1.0.0.exe'
  $clientArgs = @('-NoProfile','-ExecutionPolicy','Bypass','-File',$clientSetup,'-ServerIp',$serverIp,'-LoginMode','server','-InstallerPath',$desktopInstaller)
  $clientProcess = Start-Process -FilePath 'powershell.exe' -ArgumentList $clientArgs -Wait -PassThru
  if ($clientProcess.ExitCode -ne 0) { throw 'Server desktop app installation failed.' }
  Write-Host 'Use the Badizo B desktop shortcut. Browser URL is only for diagnostics.' -ForegroundColor Green
} catch {
  Remove-Item Env:\MYSQL_PWD -ErrorAction SilentlyContinue
  Write-Host ''
  Write-Host 'INSTALLATION FAILED' -ForegroundColor Red
  Write-Host $_.Exception.Message -ForegroundColor Red
} finally {
  Write-Host ''
  Read-Host 'Press Enter to close' | Out-Null
}
