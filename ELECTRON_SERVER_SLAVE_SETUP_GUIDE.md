# Badizo POS Electron Server / Slave Setup Guide

This guide explains how to run Badizo POS as an installed Electron app in a shop with one Server PC and multiple Slave / Counter PCs.

## Target Architecture

```text
Server PC
- MySQL database
- Backend API on port 5000
- Frontend app on port 3000
- Database backups
- Shared printers if connected to server
- Optional Electron app for local use

Slave / Counter PCs
- Electron app only
- No MySQL
- No backend
- No full source code
- Opens the Server PC POS screen over LAN
```

Do not install MySQL or run a separate backend on slave machines. One central server prevents stock mismatch, bill number mismatch, and backup confusion.

## Important Values

Replace this example IP with the real Server PC IPv4 address:

```text
192.168.1.12
```

Server URLs:

```text
Frontend: http://192.168.1.12:3000
Backend:  http://192.168.1.12:5000/api
Health:   http://192.168.1.12:5000/api/health
```

## Part 1: Server PC Setup

### 1. Confirm Server IP

On the Server PC, open PowerShell or Command Prompt:

```powershell
ipconfig
```

Find the active network adapter and note the IPv4 address.

Example:

```text
IPv4 Address . . . . . . . . . . . : 192.168.1.12
```

Use the same IP in all slave app configs.

Recommended: make the Server PC IP static in the router or Windows network settings. If this IP changes, slave apps will not know where to connect.

### 2. Make MySQL Start Automatically

Run PowerShell as Administrator:

```powershell
Set-Service MySQL80 -StartupType Automatic
Start-Service MySQL80
Get-Service MySQL80
```

Expected:

```text
Status: Running
StartType: Automatic
```

### 3. Make Backend Start Automatically

Run PowerShell as Administrator:

```powershell
schtasks /Create /TN "Badizo POS Backend" /SC ONSTART /RL HIGHEST /F /TR "powershell.exe -NoProfile -ExecutionPolicy Bypass -Command cd D:\badizo-pos-main\backend; & 'C:\Program Files\nodejs\node.exe' server.js"
```

Start it now:

```powershell
schtasks /Run /TN "Badizo POS Backend"
```

Check backend port:

```powershell
Test-NetConnection localhost -Port 5000
```

Expected:

```text
TcpTestSucceeded : True
```

Also check in browser:

```text
http://localhost:5000/api/health
```

### 4. Start Frontend On Server

For testing, run:

```powershell
cd D:\badizo-pos-main\frontend
$env:REACT_APP_API_BASE_URL="http://192.168.1.12:5000/api"
& "C:\Program Files\nodejs\npm.cmd" start
```

Check on Server browser:

```text
http://localhost:3000
```

Check from a slave browser:

```text
http://192.168.1.12:3000
```

If this does not open from slave, fix server IP/firewall/network before installing Electron on slaves.

### 5. Allow Windows Firewall On Server

Run PowerShell as Administrator:

```powershell
New-NetFirewallRule -DisplayName "Badizo Backend 5000" -Direction Inbound -Protocol TCP -LocalPort 5000 -Action Allow
New-NetFirewallRule -DisplayName "Badizo Frontend 3000" -Direction Inbound -Protocol TCP -LocalPort 3000 -Action Allow
```

### 6. Build Electron Installer

On the Server PC:

```powershell
cd D:\badizo-pos-main\frontend
$env:REACT_APP_API_BASE_URL="http://192.168.1.12:5000/api"
& "C:\Program Files\nodejs\npm.cmd" run build
```

Then:

```powershell
cd D:\badizo-pos-main\electron
& "C:\Program Files\nodejs\npm.cmd" install
& "C:\Program Files\nodejs\npm.cmd" run dist
```

Installer output folder:

```text
D:\badizo-pos-main\electron\dist
```

Example installer:

```text
Badizo Setup 1.0.0.exe
```

## Part 2: Server Electron App Setup

Install the `.exe` on the Server PC if you want to open POS as an app on the server also.

Create or update this file:

```text
C:\Users\<ServerUser>\AppData\Roaming\Badizo\app-config.json
```

Shortcut:

1. Press `Win + R`
2. Type:

```text
%APPDATA%
```

3. Create folder:

```text
Badizo
```

4. Create file:

```text
app-config.json
```

Server config:

```json
{
  "appUrl": "http://localhost:3000",
  "apiHealthUrl": "http://localhost:5000/api/health",
  "backendPort": 5000,
  "frontendPort": 3000,
  "startBackend": false,
  "startFrontend": false,
  "kiosk": false,
  "devTools": false
}
```

Reason:

- MySQL starts as a Windows service.
- Backend starts from Task Scheduler.
- Frontend is already running on Server.
- Electron only opens POS like an app window.

## Part 3: Slave / Counter PC Setup

Do not copy the complete source code to slave machines.

Copy only the installer from Server:

```text
D:\badizo-pos-main\electron\dist\Badizo Setup 1.0.0.exe
```

Install it on each slave PC.

### 1. Test Server Access From Slave Browser

On each slave, open browser and test:

```text
http://192.168.1.12:3000
```

Then:

```text
http://192.168.1.12:5000/api/health
```

If these do not open, do not continue. Fix network/firewall/server IP first.

### 2. Create Slave App Config

On each slave:

1. Press `Win + R`
2. Type:

```text
%APPDATA%
```

3. Create folder if missing:

```text
Badizo
```

4. Create file:

```text
app-config.json
```

Slave config:

```json
{
  "appUrl": "http://192.168.1.12:3000",
  "apiHealthUrl": "http://192.168.1.12:5000/api/health",
  "backendPort": 5000,
  "frontendPort": 3000,
  "startBackend": false,
  "startFrontend": false,
  "kiosk": false,
  "devTools": false
}
```

Replace `192.168.1.12` with the real Server PC IP.

### 3. Open Badizo App On Slave

Open the installed Badizo app from Desktop or Start Menu.

Expected:

- Badizo window opens.
- Login screen loads from Server.
- Billing/products/reports use Server database.

## Part 4: Daily Use

### Server PC

1. Switch on Server PC.
2. MySQL starts automatically.
3. Backend starts automatically.
4. Frontend should be running on port `3000`.
5. Open Badizo app.

### Slave PCs

1. Switch on slave PC.
2. Open Badizo app.
3. App connects to Server PC.

## Part 5: Updating Software

Update code only on Server PC.

```powershell
cd D:\badizo-pos-main
git pull
```

Install dependencies if package files changed:

```powershell
& "C:\Program Files\nodejs\npm.cmd" install
cd D:\badizo-pos-main\frontend
& "C:\Program Files\nodejs\npm.cmd" install
```

Build frontend:

```powershell
cd D:\badizo-pos-main\frontend
$env:REACT_APP_API_BASE_URL="http://192.168.1.12:5000/api"
& "C:\Program Files\nodejs\npm.cmd" run build
```

Restart backend:

```powershell
schtasks /End /TN "Badizo POS Backend"
schtasks /Run /TN "Badizo POS Backend"
```

Slave machines usually do not need reinstall because they only open the Server frontend.

Reinstall slave apps only when Electron wrapper behavior changes, such as kiosk mode, window behavior, app icon/name, or local hardware integration.

### Updating Electron App On Slaves

If Electron wrapper changed and a new installer is created, copy the new installer from:

```text
D:\badizo-pos-main\electron\dist
```

Example:

```text
Badizo Setup 1.0.0.exe
```

Then on each slave machine:

1. Close Badizo app.
2. Copy the new installer `.exe` to the slave.
3. Double-click the installer and install/replace the existing app.
4. Open Badizo app again.
5. Confirm it opens the Server POS screen.

Usually the existing slave config remains here and does not need to be recreated:

```text
C:\Users\<SlaveUser>\AppData\Roaming\Badizo\app-config.json
```

If the app opens blank after reinstall, check that the config still points to the Server PC:

```json
{
  "appUrl": "http://192.168.1.12:3000",
  "apiHealthUrl": "http://192.168.1.12:5000/api/health",
  "backendPort": 5000,
  "frontendPort": 3000,
  "startBackend": false,
  "startFrontend": false,
  "kiosk": false,
  "devTools": false
}
```

Do not reinstall slave apps for normal frontend/backend changes. Reinstall only when Electron itself changes.

## Part 6: Troubleshooting

### Slave App Opens Blank

On slave browser, test:

```text
http://192.168.1.12:3000
```

If it fails:

- Server frontend is not running.
- Server IP changed.
- Firewall is blocking port `3000`.
- Slave is not on same LAN.

### Login/API Fails

On slave browser, test:

```text
http://192.168.1.12:5000/api/health
```

If it fails:

- Backend is not running.
- Firewall is blocking port `5000`.
- Server IP changed.

### MySQL Not Available

On Server PC:

```powershell
Get-Service MySQL80
```

If stopped:

```powershell
Start-Service MySQL80
```

### PowerShell Blocks npm

Use `npm.cmd`:

```powershell
& "C:\Program Files\nodejs\npm.cmd" install
& "C:\Program Files\nodejs\npm.cmd" run build
& "C:\Program Files\nodejs\npm.cmd" run dist
```

Do not use plain `npm` if PowerShell script policy blocks `npm.ps1`.

## Final Rule

Server owns data. Slaves are only app windows.

```text
One MySQL + one backend + many Electron clients.
```
