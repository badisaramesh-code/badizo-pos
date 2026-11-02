from pathlib import Path
r=Path(r'D:\badizo-pos-main');s=r/'scripts/new-store-20260920'
p=s/'database-setup.cjs';t=p.read_text()
t=t.replace('const [mode, root] =','const [mode, root, mysqlMode] =')
t=t.replace("fs.writeFileSync(secretFile, JSON.stringify({rootPassword:", "const suffix=crypto.randomBytes(6).toString('hex');\n    fs.writeFileSync(secretFile, JSON.stringify({mysqlMode:mysqlMode||'bundled',installId:crypto.randomBytes(24).toString('hex'),dbName:mysqlMode==='existing'?'badizo_new_'+suffix:'badizo_pos',dbUser:mysqlMode==='existing'?'bz_'+suffix:'badizo_app',rootPassword:")
t=t.replace("  if (mode === 'prepare') {","  if (mode === 'prepare') {\n    if ((s.mysqlMode||'bundled')!==(mysqlMode||'bundled')) throw Error('MySQL installation mode changed; existing configuration preserved');")
a=t.index("    fs.writeFileSync(path.join(root, 'NEW_STORE_CREDENTIALS.txt')")
b=t.index("    const slash =",a)
t=t[:a]+"""    fs.writeFileSync(path.join(root, 'NEW_STORE_CREDENTIALS.txt'), 'Keep private. MySQL localhost:3306 / database '+(s.dbName||'badizo_pos')+'\\n'+(s.mysqlMode==='existing'?'Existing root password is unchanged and is not stored here.\\n':'MySQL root password: '+s.rootPassword+'\\n')+'Application DB user: '+(s.dbUser||'badizo_app')+'\\nApplication DB password: '+s.appPassword+'\\nPOS logins: see installation PDF.\\n');
"""+t[b:]
t=t.replace("'DB_USER=badizo_app'","'DB_USER='+(s.dbUser||'badizo_app')").replace("'DB_NAME=badizo_pos'","'DB_NAME='+(s.dbName||'badizo_pos')")
t=t.replace("user:'badizo_app',password:s.appPassword,database:'badizo_pos'","user:s.dbUser||'badizo_app',password:s.appPassword,database:s.dbName||'badizo_pos'")
p.write_text(t)
p=s/'start-badizo.ps1';t=p.read_text().replace("for ($i=0;","$serviceFile=Join-Path $PSScriptRoot 'mysql-service.txt'\n$mysqlService=if(Test-Path $serviceFile){(Get-Content $serviceFile -Raw).Trim()}else{'BadizoMySQL'}\nfor ($i=0;").replace('Get-Service BadizoMySQL','Get-Service $mysqlService');p.write_text(t)
p=s/'install-server.ps1';t=p.read_text()
a=t.index('$mysqlServices =');b=t.index("if (Get-NetTCPConnection -State Listen -LocalPort 5000",a)
t=t[:a]+"""$mysqlServices = @(Get-Service | Where-Object { $_.Name -match 'mysql|maria' })
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
"""+t[b:]
t=t.replace("  foreach ($name in @('backup-local.ps1','backup-dump.cjs'))","  foreach ($name in @('backup-local.ps1','backup-dump.cjs','database-existing.cjs'))")
t=t.replace("  & $node (Join-Path $InstallRoot 'database-setup.cjs') prepare $InstallRoot","  $mysqlMode=if($useExisting){'existing'}else{'bundled'}\n  & $node (Join-Path $InstallRoot 'database-setup.cjs') prepare $InstallRoot $mysqlMode")
a=t.index("  Write-Host '3/7");b=t.index("  Write-Host '4/7",a)
old=t[a:b]
t=t[:a]+"""  $serviceName | Set-Content (Join-Path $InstallRoot 'mysql-service.txt') -Encoding ASCII
  if ($useExisting) {
    Write-Host '3/7 Connecting to existing MySQL 8.0; creating an isolated NEW store database'
    $adminUser=Read-Host 'MySQL administrator username [root]'
    if (!$adminUser) {$adminUser='root'}
    $securePassword=Read-Host 'Existing MySQL administrator password (hidden)' -AsSecureString
    $bstr=[Runtime.InteropServices.Marshal]::SecureStringToBSTR($securePassword)
    try {
      $credentials=@{user=$adminUser;password=[Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)}
      $credentials | ConvertTo-Json -Compress | & $node (Join-Path $InstallRoot 'database-existing.cjs') $InstallRoot
      if($LASTEXITCODE -ne 0){throw 'Existing MySQL connection/setup failed. Check the password and administrator privileges; retry this installer.'}
    } finally {
      if($credentials){$credentials.password=''}
      [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
      $securePassword.Dispose()
    }
  } else {
"""+old+"  }\n"+t[b:]
p.write_text(t)
