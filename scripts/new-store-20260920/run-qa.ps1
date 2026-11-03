$ErrorActionPreference='Stop'
$qaRoot = 'D:\badizo-pos-main\output\new-store-20260920\qa'
$mysqlBase = 'D:\badizo-pos-main\output\new-store-20260920\package\payload\mysql'
if (Get-NetTCPConnection -State Listen -LocalPort 33360 -ErrorAction SilentlyContinue) {throw 'QA port already in use'}
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$qaData = Join-Path $qaRoot ("mysql-data-"+$stamp)
& "$mysqlBase\bin\mysqld.exe" --no-defaults --initialize-insecure "--basedir=$mysqlBase" "--datadir=$qaData" "--log-error=$qaRoot\mysql-$stamp.log"
if ($LASTEXITCODE -ne 0) {throw 'QA initialization failed'}
$qaArgs = '--no-defaults --basedir="{0}" --datadir="{1}" --port=33360 --bind-address=127.0.0.1 --mysqlx=0 --log-error="{2}"' -f $mysqlBase,$qaData,(Join-Path $qaRoot "mysql-$stamp.log")
$qaProc = Start-Process "$mysqlBase\bin\mysqld.exe" -ArgumentList $qaArgs -WindowStyle Hidden -PassThru
$qaProc.Id | Set-Content "$qaRoot\mysql.pid"
Start-Sleep -Seconds 2
try {node (Join-Path $PSScriptRoot 'qa-integration.cjs'); $code=$LASTEXITCODE}
finally {if (!$qaProc.HasExited) {$qaProc.WaitForExit(5000) | Out-Null}; if (!$qaProc.HasExited) {Stop-Process -Id $qaProc.Id}}
exit $code
