from pathlib import Path
r=Path(r'D:\badizo-pos-main')
s=r/'scripts/new-store-20260920'
p=s/'install-server.ps1'
t=p.read_text()
t=t.replace("  Write-Host '1/7 Installing", "  & (Join-Path $payload 'configure-server-lan.ps1') -InstallRoot $InstallRoot\n  if (!(Get-NetIPAddress -IPAddress '192.168.1.10' -ErrorAction SilentlyContinue)) {throw 'Fixed LAN address is missing'}\n  Write-Host '1/7 Installing")
t=t.replace("  $node = Join-Path", "  foreach ($name in @('backup-local.ps1','backup-dump.cjs')) {Copy-Item (Join-Path $payload $name) $InstallRoot -Force}\n  $node = Join-Path",1)
t=t.replace("  Write-Host '5/7", """  $backupName='Badizo Daily Local Backup'
  $oldBackup=Get-ScheduledTask -TaskName $backupName -ErrorAction SilentlyContinue
  if ($oldBackup -and $oldBackup.Actions.Arguments -notlike '*C:\\BadizoPOS\\backup-local.ps1*') {throw 'Unrelated backup task exists'}
  $backupArgs='-NoProfile -ExecutionPolicy Bypass -File "C:\\BadizoPOS\\backup-local.ps1"'
  $backupAction=New-ScheduledTaskAction -Execute "$env:SystemRoot\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -Argument $backupArgs
  $backupTriggers=@((New-ScheduledTaskTrigger -Daily -At '09:00'),(New-ScheduledTaskTrigger -AtStartup))
  $backupSettings=New-ScheduledTaskSettingsSet -StartWhenAvailable -WakeToRun -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew -RestartCount 6 -RestartInterval (New-TimeSpan -Minutes 5) -ExecutionTimeLimit (New-TimeSpan -Hours 2)
  Register-ScheduledTask -TaskName $backupName -Action $backupAction -Trigger $backupTriggers -Principal $taskPrincipal -Settings $backupSettings -Force | Out-Null
  Write-Host '5/7""")
t=t.replace('-RemoteAddress LocalSubnet','-RemoteAddress Any')
t=t.replace("@{serverName=$env:COMPUTERNAME;addresses=$addresses;port=5000}","@{serverName='192.168.1.10';addresses=$addresses;port=5000}")
t=t.replace("('Client server name: ' + $env:COMPUTERNAME)","'Client server: 192.168.1.10:5000'")
t=t.replace("'Set the store LAN network profile to Private and reserve server IP in the router.'","'Exclude 192.168.1.10 from router DHCP. Clients use any unique reachable LAN address.'")
t=t.replace("at 22:30. Keep server awake.","at 09:00 daily; missed backup runs after startup. SQL + barcode PRN ZIP.")
t=t.replace("  $state.complete = $true", "  Start-ScheduledTask -TaskName $backupName\n  $state.complete = $true")
p.write_text(t)
p=s/'database-setup.cjs';t=p.read_text().replace('BACKUP_DAILY_TIME=22:30','BACKUP_DAILY_TIME=09:00').replace('BADIZO_ENABLE_LOCAL_BACKUP_SCHEDULE=true','BADIZO_ENABLE_LOCAL_BACKUP_SCHEDULE=false');p.write_text(t)
p=r/'backend/config/db.js';t=p.read_text();t=t.replace("['backup_daily_time', '22:30']","['backup_daily_time', '09:00']")
# scope the one-time new-store seed, preserve legacy defaults
start=t.index("if (process.env.BADIZO_NEW_STORE")
t=t[:start]+t[start:].replace("'22:30'","'09:00'",1);p.write_text(t)
p=s/'launcher.ps1';t=p.read_text();a=t.index("  $name =");b=t.index("  $url =",a);t=t[:a]+"  $name = '192.168.1.10'\n"+t[b:];t=t.replace('$serverName = $env:COMPUTERNAME',"$serverName = '192.168.1.10'");p.write_text(t)
p=r/'output/new-store-20260920/package/payload/setup-slave-app.ps1';t=p.read_text();t=t.replace("@('badizo-server.local', 'badizo-server', 'BADIZO-SERVER', 'server', 'SERVER')","@('192.168.1.10')").replace("$serverHost = 'badizo-server'","$serverHost = '192.168.1.10'").replace("@($serverHost, $ServerIp) + $ServerHosts + @('badizo-server.local', 'badizo-server', 'server')","@('192.168.1.10')").replace('discoveryEnabled = $true','discoveryEnabled = $false');p.write_text(t);(s/'setup-slave-app.ps1').write_text(t)
p=r/'electron/main.js';t=p.read_text().replace('      readCachedServerHost(),','      ...(config.discoveryEnabled !== false ? [readCachedServerHost()] : []),')
t=t.replace("    'badizo-server.local',\n    'badizo-server',\n    'BADIZO-SERVER',\n    'server',\n    'SERVER'","    ...(config.discoveryEnabled ? ['badizo-server.local', 'badizo-server', 'BADIZO-SERVER', 'server', 'SERVER'] : [])")
p.write_text(t)
import json
p=r/'output/new-store-20260920/app-config.json';c=json.loads(p.read_text());c.update(appUrl='http://192.168.1.10:5000',apiHealthUrl='http://192.168.1.10:5000/api/health',serverHosts=['192.168.1.10'],discoveryEnabled=False);p.write_text(json.dumps(c))
