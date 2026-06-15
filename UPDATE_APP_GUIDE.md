# Badizo POS Update Scripts Guide

Use these scripts on the Server PC to make the app ready after code changes.

Run PowerShell as Administrator when a script needs to restart or create Windows scheduled tasks.

## Normal Update After Git Pull

Recommended all-in-one command:

```powershell
cd D:\badizo-pos-main
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\windows\update-badizo-app.ps1 -ServerIp 192.168.1.12
```

If Electron also changed and you need a new installer for Server/slaves:

```powershell
cd D:\badizo-pos-main
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\windows\update-badizo-app.ps1 -ServerIp 192.168.1.12 -BuildElectron
```

Use this for normal backend/frontend changes:

```powershell
cd D:\badizo-pos-main
.\scripts\windows\update-server-app.ps1 -ServerIp 192.168.1.12
```

What it does:

1. Runs `git pull`.
2. Runs backend `npm install`.
3. Runs frontend `npm install`.
4. Builds frontend with:

```text
REACT_APP_API_BASE_URL=http://SERVER-IP:5000/api
```

5. Restarts `Badizo POS Backend` scheduled task if it exists.
6. Starts backend directly once if the task is missing or unhealthy.
7. Stops with an error if port `5000` is still not reachable.

If you already pulled code manually:

```powershell
.\scripts\windows\update-server-app.ps1 -ServerIp 192.168.1.12 -SkipGitPull
```

If dependencies did not change and you want a faster run:

```powershell
.\scripts\windows\update-server-app.ps1 -ServerIp 192.168.1.12 -SkipInstall
```

## Build Electron Installer

Use this only when Electron wrapper changed, such as:

- `electron/main.js`
- `electron/package.json`
- `electron/installer.nsh`
- app icon/logo
- window/kiosk behavior
- app config behavior

Command:

```powershell
cd D:\badizo-pos-main
.\scripts\windows\build-electron-installer.ps1 -ServerIp 192.168.1.12
```

Output:

```text
D:\badizo-pos-main\electron\dist\Badizo Setup 1.0.0.exe
```

Copy this installer to slave machines only when Electron changed. For normal frontend/backend updates, slaves do not need reinstall.

## Install Backend Startup Task

Run once on Server PC:

```powershell
cd D:\badizo-pos-main
.\scripts\windows\install-backend-startup-task.ps1
```

This creates:

```text
Badizo POS Backend
```

If Windows says `Access is denied`, open PowerShell using **Run as administrator** and run the same command again. Without Administrator permission, the script creates a fallback task that starts backend when the server Windows user logs in. That works if the server user stays logged in, but the Administrator startup task is better because it starts immediately after Windows boots.

## Install Frontend Startup Task

If you host frontend using `npm start` on the server, run once:

```powershell
cd D:\badizo-pos-main
.\scripts\windows\install-frontend-startup-task.ps1 -ServerIp 192.168.1.12
```

This creates:

```text
Badizo POS Frontend
```

## Update With Frontend Task Restart

If your frontend is running from the scheduled task and you want the script to restart it:

```powershell
.\scripts\windows\update-server-app.ps1 -ServerIp 192.168.1.12 -RestartFrontendTask
```

## PowerShell Blocks Script Execution

Use this form:

```powershell
powershell.exe -ExecutionPolicy Bypass -File .\scripts\windows\update-server-app.ps1 -ServerIp 192.168.1.12
```

## Daily Rule

Normal software change:

```text
Run update-server-app.ps1 on Server only.
```

Electron wrapper/logo/window change:

```text
Run build-electron-installer.ps1, then install the new .exe on Server and slaves.
```

## Slave Machine Setup

Copy these two files to the slave machine in one folder:

```text
Badizo Setup 1.0.0.exe
setup-slave-app.ps1
```

Run this on the slave from PowerShell:

```powershell
cd C:\BadizoSetup
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\setup-slave-app.ps1 -ServerIp 192.168.1.12
```

The slave does not need the full source code. The script checks `192.168.1.12:5000`, writes the Electron config to `%APPDATA%\Badizo\app-config.json`, installs the app, and opens it.
