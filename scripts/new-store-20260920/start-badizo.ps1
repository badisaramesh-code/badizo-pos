$ErrorActionPreference = 'Stop'
Set-Location (Join-Path $PSScriptRoot 'backend')
$node = Join-Path $PSScriptRoot 'runtime\node.exe'
$logDir = Join-Path $PSScriptRoot 'backend\logs'
New-Item -ItemType Directory -Force $logDir | Out-Null
$serviceFile=Join-Path $PSScriptRoot 'mysql-service.txt'
$mysqlService=if(Test-Path $serviceFile){(Get-Content $serviceFile -Raw).Trim()}else{'BadizoMySQL'}
for ($i=0;$i -lt 60;$i++) {
  if ((Get-Service $mysqlService -ErrorAction SilentlyContinue).Status -eq 'Running') { break }
  Start-Sleep -Seconds 2
}
$ErrorActionPreference = 'Continue'
& $node server.js >> (Join-Path $logDir 'server.out.log') 2>> (Join-Path $logDir 'server.err.log')
exit $LASTEXITCODE
