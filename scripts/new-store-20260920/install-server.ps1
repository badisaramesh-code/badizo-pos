param([string]$InstallRoot = 'C:\BadizoPOS')
$ErrorActionPreference = 'Stop'
$payload = $PSScriptRoot
$serviceName = 'BadizoMySQL'
$taskName = 'Badizo POS Backend'
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object Security.Principal.WindowsPrincipal($identity)
if (!$principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'Run SERVER installation through START_HERE.bat.' }
if (![Environment]::Is64BitOperatingSystem) { throw 'Windows x64 is required.' }
$InstallRoot = [IO.Path]::GetFullPath($InstallRoot).TrimEnd('\')
if ($InstallRoot -ne 'C:\BadizoPOS') { throw 'This release installs only to C:\BadizoPOS.' }
$markerPath = Join-Path $InstallRoot 'new-store-install.json'
$state = $null
if (Test-Path $InstallRoot) {
  if (!(Test-Path $markerPath)) { throw 'C:\BadizoPOS already exists. Fresh installer will not overwrite it. Use a clean PC.' }
  $state = Get-Content $markerPath -Raw | ConvertFrom-Json
  if ($state.release -ne '2026-09-20') { throw 'Different installation detected. Stopping.' }
  if ($state.complete) { Write-Host 'Already installed. Use Badizo POS desktop shortcut.'; exit 0 }
}
$mysqlServices = @(Get-Service | Where-Object { $_.Name -match 'mysql|maria' })
$useExisting=$false
$external=@($mysqlServices | Where-Object Name -ne $serviceName)
if ($external.Count) {
 if ($external.Count -ne 1 -or $external[0].Name -match 'maria') {throw 'Select a server with one MySQL 8.0 service; multiple/MariaDB services require technician review.'}
 $serviceName=$external[0].Name
 $info=Get-CimInstance Win32_Service | Where-Object Name -eq $serviceName
 if ($info.State -ne 'Running' -or $info.StartMode -ne 'Auto') {throw 'Existing MySQL must be Running with Automatic startup.'}
 $listeners=@(Get-NetTCPConnection -State Listen -LocalPort 3306 -ErrorAction SilentlyContinue)
 if (!$listeners.Count) {throw 'Existing MySQL must listen on port 3306.'}
 foreach ($listener in $listeners) {
  $owner=[int]$listener.OwningProcess
  for($n=0;$n -lt 5 -and $owner -ne [int]$info.ProcessId -and $owner -gt 0;$n++) {
   $proc=Get-CimInstance Win32_Process -Filter ("ProcessId="+$owner)
   $owner=[int]$proc.ParentProcessId
  }
  if($owner -ne [int]$info.ProcessId){throw 'Port 3306 does not belong to the selected MySQL service.'}
 }
 $useExisting=$true
 Write-Host ('Using existing MySQL service: '+$serviceName+' on port 3306. Existing data is preserved.')
} elseif ((Get-Service $serviceName -ErrorAction SilentlyContinue) -and !$state) {
 throw 'Existing BadizoMySQL service has no matching package marker. Stopping.'
}
if (Get-NetTCPConnection -State Listen -LocalPort 5000 -ErrorAction SilentlyContinue) {
  if (!$state) { throw 'Port 5000 is in use. Existing POS is preserved. Use a clean server PC.' }
  $task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
  if (!$task -or $task.Actions.Arguments -notlike '*C:\BadizoPOS\start-badizo.ps1*') { throw 'Port 5000 belongs to another application.' }
  Stop-ScheduledTask -TaskName $taskName
  Start-Sleep -Seconds 3
}
if ((Get-NetTCPConnection -State Listen -LocalPort 3306 -ErrorAction SilentlyContinue) -and !(Get-Service $serviceName -ErrorAction SilentlyContinue)) { throw 'Port 3306 is already occupied. Existing database will not be changed.' }
if ((Get-PSDrive C).Free -lt 6GB) { throw 'At least 6 GB of free space on C: is required.' }
New-Item -ItemType Directory -Force $InstallRoot | Out-Null
if (!$state) {
  $state = [pscustomobject]@{release='2026-09-20';complete=$false}
  $state | ConvertTo-Json | Set-Content $markerPath -Encoding UTF8
}
$log = Join-Path $InstallRoot 'installation.log'
Start-Transcript -Path $log -Append | Out-Null
try {
  & (Join-Path $payload 'configure-server-lan.ps1') -InstallRoot $InstallRoot
  if (!(Get-NetIPAddress -IPAddress '192.168.1.10' -ErrorAction SilentlyContinue)) {throw 'Fixed LAN address is missing'}
  Write-Host '1/7 Installing bundled Microsoft Visual C++ runtime'
  $vc = Start-Process -FilePath (Join-Path $payload 'VC_redist.x64.exe') -ArgumentList '/install /quiet /norestart' -WindowStyle Hidden -Wait -PassThru
  if ($vc.ExitCode -notin @(0,1638,3010)) { throw "Visual C++ installation failed: $($vc.ExitCode)" }
  if ($vc.ExitCode -eq 3010) { Write-Warning 'Windows restart is required after installation.' }
  Write-Host '2/7 Copying current POS, MySQL and Node runtime'
  foreach ($dir in @('backend','frontend','barcode','thermal','assets')) {
    & robocopy.exe (Join-Path $payload "app\$dir") (Join-Path $InstallRoot $dir) /E /NFL /NDL /NJH /NJS /NP /R:1 /W:1 | Out-Null
    if ($LASTEXITCODE -ge 8) { throw "Copy failed: $dir" }
  }
  foreach ($dir in @('runtime','mysql')) {
    & robocopy.exe (Join-Path $payload $dir) (Join-Path $InstallRoot $dir) /E /NFL /NDL /NJH /NJS /NP /R:1 /W:1 | Out-Null
    if ($LASTEXITCODE -ge 8) { throw "Copy failed: $dir" }
  }
  Copy-Item (Join-Path $payload 'database-setup.cjs') $InstallRoot -Force
  Copy-Item (Join-Path $payload 'start-badizo.ps1') $InstallRoot -Force
  foreach ($name in @('backup-local.ps1','backup-dump.cjs','database-existing.cjs')) {Copy-Item (Join-Path $payload $name) $InstallRoot -Force}
  $node = Join-Path $InstallRoot 'runtime\node.exe'
  $mysqlMode=if($useExisting){'existing'}else{'bundled'}
  & $node (Join-Path $InstallRoot 'database-setup.cjs') prepare $InstallRoot $mysqlMode
  if ($LASTEXITCODE -ne 0) { throw 'Credential preparation failed.' }
  $privateFiles = @('install-secrets.json','NEW_STORE_CREDENTIALS.txt','backend\.env')
  foreach ($name in $privateFiles) {
    $file = Join-Path $InstallRoot $name
    if (Test-Path $file) {
      & icacls.exe $file /inheritance:r /grant:r '*S-1-5-18:F' '*S-1-5-32-544:F' | Out-Null
      if ($LASTEXITCODE -ne 0) { throw "Could not protect configuration: $name" }
    }
  }
  $serviceName | Set-Content (Join-Path $InstallRoot 'mysql-service.txt') -Encoding ASCII
  if ($useExisting) {
    Write-Host '3/7 Connecting to existing MySQL 8.0; creating an isolated NEW store database'
    $adminUser=Read-Host 'MySQL administrator username [root]'
    if (!$adminUser) {$adminUser='root'}
    $securePassword=Read-Host 'Existing MySQL administrator password (hidden)' -AsSecureString
    $bstr=[Runtime.InteropServices.Marshal]::SecureStringToBSTR($securePassword)
    $savedOutputEncoding=$OutputEncoding
    try {
      $OutputEncoding=[Text.UTF8Encoding]::new($false)
      $credentials=@{user=$adminUser;password=[Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)}
      $credentials | ConvertTo-Json -Compress | & $node (Join-Path $InstallRoot 'database-existing.cjs') $InstallRoot
      if($LASTEXITCODE -ne 0){throw 'Existing MySQL connection/setup failed. Check the password and administrator privileges; retry this installer.'}
    } finally {
      $OutputEncoding=$savedOutputEncoding
      if($credentials){$credentials.password=''}
      [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
      $securePassword.Dispose()
    }
  } else {
  Write-Host '3/7 Initializing a NEW empty MySQL database'
  $mysqlExe = Join-Path $InstallRoot 'mysql\bin\mysqld.exe'
  $ini = Join-Path $InstallRoot 'mysql\my.ini'
  $rootForward = $InstallRoot.Replace('\','/')
  @('[mysqld]',"basedir=$rootForward/mysql","datadir=$rootForward/mysql-data",'port=3306','bind-address=127.0.0.1','mysqlx=0','character-set-server=utf8mb4','collation-server=utf8mb4_unicode_ci',"log-error=$rootForward/mysql-error.log") | Set-Content $ini -Encoding ASCII
  if (!(Test-Path (Join-Path $InstallRoot 'mysql-data\mysql'))) {
    if ((Test-Path (Join-Path $InstallRoot 'mysql-data')) -and @(Get-ChildItem (Join-Path $InstallRoot 'mysql-data') -Force).Count) { throw 'Partial MySQL data directory found. Review mysql-error.log; do not delete existing data.' }
    & $mysqlExe "--defaults-file=$ini" --initialize-insecure
    if ($LASTEXITCODE -ne 0) { throw 'MySQL initialization failed. See C:\BadizoPOS\mysql-error.log.' }
  }
  if (!(Get-Service $serviceName -ErrorAction SilentlyContinue)) {
    & $mysqlExe --install $serviceName "--defaults-file=$ini"
    if ($LASTEXITCODE -ne 0) { throw 'MySQL service registration failed.' }
  }
  Set-Service $serviceName -StartupType Automatic
  Start-Service $serviceName
  & $node (Join-Path $InstallRoot 'database-setup.cjs') initialize $InstallRoot
  if ($LASTEXITCODE -ne 0) { throw 'Database bootstrap failed. Retry this installer; credentials are preserved.' }
  }
  Write-Host '4/7 Registering automatic startup'
  New-Item -ItemType Directory -Force (Join-Path $InstallRoot 'backend\logs'),(Join-Path $InstallRoot 'backups') | Out-Null
  $existingTask = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
  if ($existingTask -and $existingTask.Actions.Arguments -notlike '*C:\BadizoPOS\start-badizo.ps1*') { throw 'A different Badizo startup task already exists. It was not replaced.' }
  $startPath = Join-Path $InstallRoot 'start-badizo.ps1'
  $argsText = '-NoProfile -ExecutionPolicy Bypass -File "{0}"' -f $startPath
  $action = New-ScheduledTaskAction -Execute "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" -Argument $argsText
  $trigger = New-ScheduledTaskTrigger -AtStartup
  $taskPrincipal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
  $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Hours 0) -RestartCount 10 -RestartInterval (New-TimeSpan -Minutes 1) -StartWhenAvailable
  Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Principal $taskPrincipal -Settings $settings -Force | Out-Null
  $backupName='Badizo Daily Local Backup'
  $oldBackup=Get-ScheduledTask -TaskName $backupName -ErrorAction SilentlyContinue
  if ($oldBackup -and $oldBackup.Actions.Arguments -notlike '*C:\BadizoPOS\backup-local.ps1*') {throw 'Unrelated backup task exists'}
  $backupArgs='-NoProfile -ExecutionPolicy Bypass -File "C:\BadizoPOS\backup-local.ps1"'
  $backupAction=New-ScheduledTaskAction -Execute "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" -Argument $backupArgs
  $backupTriggers=@((New-ScheduledTaskTrigger -Daily -At '09:00'),(New-ScheduledTaskTrigger -AtStartup))
  $backupSettings=New-ScheduledTaskSettingsSet -StartWhenAvailable -WakeToRun -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew -RestartCount 6 -RestartInterval (New-TimeSpan -Minutes 5) -ExecutionTimeLimit (New-TimeSpan -Hours 2)
  Register-ScheduledTask -TaskName $backupName -Action $backupAction -Trigger $backupTriggers -Principal $taskPrincipal -Settings $backupSettings -Force | Out-Null
  Write-Host '5/7 Allowing POS access on trusted LAN'
  if (!(Get-NetFirewallRule -DisplayName 'Badizo New Store LAN 5000' -ErrorAction SilentlyContinue)) {
    New-NetFirewallRule -DisplayName 'Badizo New Store LAN 5000' -Direction Inbound -Action Allow -Protocol TCP -LocalPort 5000 -Profile Private,Domain -RemoteAddress Any | Out-Null
  }
  Write-Host '6/7 Starting server and verifying database schema + frontend'
  Start-ScheduledTask -TaskName $taskName
  & $node (Join-Path $InstallRoot 'database-setup.cjs') verify $InstallRoot
  if ($LASTEXITCODE -ne 0) { throw 'Server verification failed. Read installation.log and backend\logs. Rerun installer after correcting the error.' }
  $addresses = @(Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' } | Select-Object -ExpandProperty IPAddress)
  @{serverName='192.168.1.10';addresses=$addresses;port=5000} | ConvertTo-Json | Set-Content (Join-Path $InstallRoot 'SERVER_CONNECTION.json') -Encoding UTF8
  Start-ScheduledTask -TaskName $backupName
  $state.complete = $true
  $state | ConvertTo-Json | Set-Content $markerPath -Encoding UTF8
  Write-Host '7/7 SERVER READY' -ForegroundColor Green
  Write-Host 'Client server: 192.168.1.10:5000'
  Write-Host ('Server IPv4: ' + ($addresses -join ', '))
  Write-Host 'Exclude 192.168.1.10 from router DHCP. Clients use any unique reachable LAN address.'
  Write-Host 'Database credentials: C:\BadizoPOS\NEW_STORE_CREDENTIALS.txt (Administrator only)'
  Write-Host 'Local backup: C:\BadizoPOS\backups at 09:00 daily; missed backup runs after startup. SQL + barcode PRN ZIP.'
} catch {
  Write-Host ('INSTALLATION FAILED: ' + $_.Exception.Message) -ForegroundColor Red
  exit 1
} finally {
  Stop-Transcript -ErrorAction SilentlyContinue | Out-Null
}
