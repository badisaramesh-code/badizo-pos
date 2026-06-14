# Badizo POS Browser Test Setup Guide

Last verified on: 2026-06-13  
Server PC used: Windows 11 Pro 64-bit  
Project path: `D:\badizo-pos-main\badizo-pos-main`

This guide documents the browser-only setup we completed for Badizo POS. Electron packaging is intentionally skipped until the software is ready.

## 1. What This Setup Runs

For browser testing, only these parts are required:

- MySQL database server on port `3306`
- Node/Express backend on port `5000`
- React frontend development server on port `3000`
- Browser URL: `http://localhost:3000`

Electron is not required for this stage.

## 2. Installed Versions

Verified on this server PC:

```text
Node.js: v24.16.0
npm: 11.13.0
MySQL: 8.0.46 Community Server
MySQL service: MySQL80
Windows: Windows 11 Pro 64-bit
```

Important paths:

```text
Node:
C:\Program Files\nodejs\node.exe
C:\Program Files\nodejs\npm.cmd

MySQL:
C:\Program Files\MySQL\MySQL Server 8.0\bin\mysql.exe
C:\Program Files\MySQL\MySQL Server 8.0\bin\mysqldump.exe
```

## 3. MySQL Installation Choices

During MySQL Installer setup:

- Setup type: `Custom`
- Install:
  - MySQL Server 8.0.x x64
  - MySQL Workbench
  - MySQL Shell optional
- Port: `3306`
- Authentication: strong password encryption
- Windows service name: `MySQL80`
- Startup type: automatic

If the installer does not show `High Availability` or `Start at startup`, ignore that and finish installation. We can configure service startup after installation.

Command used to make MySQL auto-start:

```powershell
Set-Service -Name MySQL80 -StartupType Automatic
Start-Service -Name MySQL80
Get-Service -Name MySQL80
```

Expected result:

```text
Name     Status   StartType
MySQL80  Running  Automatic
```

If `MySQL80` is not found, find the actual service name:

```powershell
Get-Service | Where-Object { $_.Name -like "*mysql*" -or $_.DisplayName -like "*mysql*" }
```

## 4. Create The Database

Open MySQL Workbench, connect to local MySQL, and run:

```sql
CREATE DATABASE IF NOT EXISTS badizo_pos
CHARACTER SET utf8mb4
COLLATE utf8mb4_unicode_ci;
```

Then select it before running manual queries:

```sql
USE badizo_pos;
SHOW TABLES;
```

### Error: `Error Code: 1046. No database selected`

Reason:

MySQL Workbench did not know which database/schema to use.

Fix:

Run:

```sql
USE badizo_pos;
```

Or double-click `badizo_pos` in the Workbench `SCHEMAS` sidebar until it becomes bold.

## 5. Important Schema Rule

Do not run `database/schema.sql` for this current setup.

Reason:

- That file is older than the backend's current schema initializer.
- It contains `DROP DATABASE IF EXISTS badizo_pos`.
- Running it can remove current tables and reset the database.

What we did instead:

1. Created an empty database named `badizo_pos`.
2. Started the backend.
3. The backend auto-created/upgraded the current schema from `backend/config/db.js`.

Verified schema after backend startup:

```text
Table count: 28
Default users created: server, admin, counter1
```

## 6. Backend Environment File

The backend env file must exist here:

```text
D:\badizo-pos-main\badizo-pos-main\backend\.env
```

Template:

```env
DB_HOST=localhost
DB_USER=root
DB_PASSWORD=YOUR_MYSQL_ROOT_PASSWORD
DB_NAME=badizo_pos
PORT=5000
JWT_SECRET=GENERATE_A_LONG_RANDOM_SECRET
PASSWORD_VAULT_KEY=GENERATE_ANOTHER_LONG_RANDOM_SECRET
BACKUP_DIR=D:\BadizoPOSBackups
BACKUP_DAILY_TIME=22:30
MYSQLDUMP_PATH=C:\Program Files\MySQL\MySQL Server 8.0\bin\mysqldump.exe
MYSQL_PATH=C:\Program Files\MySQL\MySQL Server 8.0\bin\mysql.exe
```

Do not share this file publicly because it contains the database password and app secrets.

Command used to generate random secrets in Windows PowerShell:

```powershell
$rng = New-Object System.Security.Cryptography.RNGCryptoServiceProvider
$bytes = New-Object byte[] 32
$rng.GetBytes($bytes)
([BitConverter]::ToString($bytes) -replace '-', '')
```

Run it twice: one value for `JWT_SECRET`, another for `PASSWORD_VAULT_KEY`.

## 7. Install Project Dependencies

Because this project has lockfiles, use `npm ci`, not `npm install`.

Backend:

```powershell
cd D:\badizo-pos-main\badizo-pos-main\backend
npm ci
```

Frontend:

```powershell
cd D:\badizo-pos-main\badizo-pos-main\frontend
npm ci
```

### Error: `node` / `npm` not recognized

Reason:

Node.js was installed, but the current PowerShell terminal had not refreshed the Windows PATH.

Fix options:

1. Close and reopen PowerShell.
2. Or run Node/npm by absolute path:

```powershell
& 'C:\Program Files\nodejs\node.exe' -v
& 'C:\Program Files\nodejs\npm.cmd' -v
```

### Error During Frontend Install

Error seen:

```text
'node' is not recognized as an internal or external command
```

Reason:

`npm ci` started using `npm.cmd`, but a package postinstall script called `node` by name. Since the terminal PATH was stale, that postinstall failed.

Fix command used:

```powershell
cd D:\badizo-pos-main\badizo-pos-main\frontend
$env:Path = 'C:\Program Files\nodejs;' + $env:Path
& 'C:\Program Files\nodejs\npm.cmd' ci
```

## 8. Start Backend

Normal command after reopening PowerShell:

```powershell
cd D:\badizo-pos-main\badizo-pos-main\backend
npm run dev
```

Fallback command used when PATH was not refreshed:

```powershell
$logDir = 'D:\badizo-pos-main\badizo-pos-main\backend\logs'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
Start-Process `
  -FilePath 'C:\Program Files\nodejs\node.exe' `
  -ArgumentList 'server.js' `
  -WorkingDirectory 'D:\badizo-pos-main\badizo-pos-main\backend' `
  -WindowStyle Hidden `
  -RedirectStandardOutput (Join-Path $logDir 'backend.out.log') `
  -RedirectStandardError (Join-Path $logDir 'backend.err.log')
```

Verify backend:

```powershell
Invoke-WebRequest -UseBasicParsing -Uri 'http://localhost:5000/api/health' -TimeoutSec 5
```

Expected content:

```json
{"ok":true}
```

### Error: `EADDRINUSE: address already in use :::5000`

Reason:

The backend was already running on port `5000`, and a second backend start was attempted.

Fix:

Do not start another backend. Check the running port:

```powershell
netstat -ano | Select-String ':5000'
```

If you really need to stop it:

```powershell
Stop-Process -Id YOUR_PID -Force
```

## 9. Start Frontend

Normal command after reopening PowerShell:

```powershell
cd D:\badizo-pos-main\badizo-pos-main\frontend
$env:BROWSER = 'none'
npm start
```

Fallback command used when `npm start` could not resolve local scripts:

```powershell
$env:BROWSER = 'none'
$env:PORT = '3000'
$logDir = 'D:\badizo-pos-main\badizo-pos-main\frontend\logs'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
Start-Process `
  -FilePath 'C:\Program Files\nodejs\node.exe' `
  -ArgumentList 'node_modules\react-scripts\bin\react-scripts.js','start' `
  -WorkingDirectory 'D:\badizo-pos-main\badizo-pos-main\frontend' `
  -WindowStyle Hidden `
  -RedirectStandardOutput (Join-Path $logDir 'frontend.out.log') `
  -RedirectStandardError (Join-Path $logDir 'frontend.err.log')
```

Verify frontend:

```powershell
Invoke-WebRequest -UseBasicParsing -Uri 'http://localhost:3000' -TimeoutSec 10
```

Expected:

```text
StatusCode 200
```

Frontend log success message:

```text
Compiled successfully!
Local: http://localhost:3000
On Your Network: http://192.168.1.12:3000
```

### Error: `'react-scripts' is not recognized`

Reason:

The local `node_modules\.bin` command was not resolved correctly in the hidden process.

Fix:

Start React directly with:

```powershell
& 'C:\Program Files\nodejs\node.exe' node_modules\react-scripts\bin\react-scripts.js start
```

Or use the full fallback `Start-Process` command above.

## 10. Browser Login Test

Open:

```text
http://localhost:3000
```

Default users created by the backend:

```text
server   / server123
admin    / admin123
counter1 / counter123
```

API login test command:

```powershell
Invoke-RestMethod `
  -Uri 'http://localhost:5000/api/auth/login' `
  -Method Post `
  -ContentType 'application/json' `
  -Body '{"username":"admin","password":"admin123"}'
```

Expected:

The response should include user role `ADMIN` and a token.

## 11. Check Tables And Row Counts

Run this from the backend folder:

```powershell
cd D:\badizo-pos-main\badizo-pos-main\backend
& 'C:\Program Files\nodejs\node.exe' -e "require('dotenv').config(); const mysql=require('mysql2/promise'); (async()=>{const c=await mysql.createConnection({host:process.env.DB_HOST,user:process.env.DB_USER,password:process.env.DB_PASSWORD,database:process.env.DB_NAME}); const tables=['users','app_settings','products','invoices','invoice_items','inward_entries','customers','invoice_sequences']; for (const t of tables){ const [r]=await c.query('SELECT COUNT(*) AS count FROM ??',[t]); console.log(t + '=' + r[0].count); } await c.end();})().catch(e=>{console.error(e.message); process.exit(1);});"
```

Fresh setup result we saw:

```text
users=3
app_settings=11
products=0
invoices=0
invoice_items=0
inward_entries=0
customers=0
invoice_sequences=1
```

This means schema/users/settings are ready, but product and invoice data are empty, which is correct for fresh testing.

## 12. Stop Or Restart Servers

Check what is using ports `3000` and `5000`:

```powershell
netstat -ano | Select-String ':3000|:5000'
```

Stop a process by PID:

```powershell
Stop-Process -Id YOUR_PID -Force
```

Then start backend and frontend again using the commands above.

## 13. Product Import Troubleshooting

### Error: `Import failed before completion: SAVEPOINT product_import_row does not exist`

Reason:

The backend product import used a row-level MySQL savepoint named `product_import_row`. If a row-level database error happened and the savepoint was already gone or invalid, the rollback attempted:

```sql
ROLLBACK TO SAVEPOINT product_import_row;
```

That rollback failed and became the main import failure.

Fix applied:

- Updated `backend/routes/products.js`.
- Added defensive savepoint handling.
- If rollback to the row savepoint fails, the backend now logs the rollback problem and records the original row import error instead of aborting the entire import.

Verification command used:

```powershell
cd D:\badizo-pos-main\badizo-pos-main
& 'C:\Program Files\nodejs\node.exe' --check backend\routes\products.js
```

Then backend was restarted and a test product import was run through the real API:

```text
inserted=1
updated=0
errorRows=0
rollbackDeletedProducts=1
```

This confirmed product import works after the fix, and the temporary test product was removed through import rollback.

After changing backend code, restart backend:

```powershell
netstat -ano | Select-String ':5000'
Stop-Process -Id BACKEND_PID -Force

cd D:\badizo-pos-main\badizo-pos-main\backend
npm run dev
```

If PATH is still not refreshed, start with:

```powershell
cd D:\badizo-pos-main\badizo-pos-main\backend
& 'C:\Program Files\nodejs\node.exe' server.js
```

## 14. Current Known Notes

- Frontend `npm ci` reported dependency vulnerabilities from old frontend tooling such as `react-scripts`. Do not run `npm audit fix --force` casually because it can break the app by changing major dependency versions.
- Electron is intentionally skipped for now.
- The current app should be tested through the browser first.
- Products are empty on a fresh setup. Add products manually or import CSV before testing billing.
- For other counter PCs later, reserve the server IP in the router and allow firewall access to required ports.
