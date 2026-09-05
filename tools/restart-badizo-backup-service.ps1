$ErrorActionPreference = 'Stop'
Restart-Service -Name 'BadizoServer' -Force
$service = Get-Service -Name 'BadizoServer'
$service.WaitForStatus('Running', [TimeSpan]::FromSeconds(30))
$service.Refresh()
[pscustomobject]@{ Name=$service.Name; Status=$service.Status; StartType=$service.StartType; RestartedAt=(Get-Date) } | ConvertTo-Json | Set-Content -LiteralPath 'D:\badizo-pos-main\tools\restart-badizo-backup-service.result.json'