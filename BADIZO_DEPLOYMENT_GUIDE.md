# Badizo Deployment Guide

This guide explains both situations:

1. Existing shop where server app is already installed and running.
2. New shop where server, slaves, MySQL, Node.js, and database need setup.

Default server IP used in scripts:

```text
192.168.1.12
```

If a shop uses a different server IP, edit the `SERVER_IP` line inside the `.bat` file before running it.

```bat
set "SERVER_IP=192.168.1.12"
```

## Important Folder Meaning

When a command says:

```text
dist\shop-update
```

it means this full folder:

```text
C:\Users\badis\Downloads\BADIZO_COMPLETE_APPLICATION\dist\shop-update
```

When a command says:

```text
dist\new-shop-deployment
```

it means this full folder:

```text
C:\Users\badis\Downloads\BADIZO_COMPLETE_APPLICATION\dist\new-shop-deployment
```

These folders are created by build scripts. Copy the full folder to the shop PC. Do not copy only one file unless the step specifically says so.

## Case 1: Existing Shop

Use this when the shop server already has Badizo installed and running.

### Existing Shop: Setup Slaves

On each slave PC, keep these three files in one folder:

```text
setup-slave-one-click.bat
setup-slave-app.ps1
Badizo Setup 1.0.0.exe
```

Double-click:

```text
setup-slave-one-click.bat
```

The slave setup will:

- Check server frontend: `http://192.168.1.12:3000`
- Check server backend: `http://192.168.1.12:5000/api/health`
- Install Badizo Electron app.
- Configure the slave app to connect to the server.
- Launch Badizo.

Slaves do not need MySQL, backend, or frontend server. Slaves only run the Electron app and connect to the server.

### Existing Shop: Update Server and Slaves

Do this whenever you have made code changes and want to update the shop.

#### If Existing Server Still Has Git/Repo Folder

Use this when the shop server itself has this folder:

```text
C:\Users\badis\Downloads\BADIZO_COMPLETE_APPLICATION
```

and the latest code is available in GitHub.

On the server PC, double-click:

```text
scripts\windows\update-existing-server-from-git-one-click.bat
```

This will:

- Pull latest code from Git.
- Install backend dependencies.
- Install frontend dependencies.
- Build frontend for the server IP.
- Restart backend.
- Restart frontend task.
- Check backend health.

Use this for your current existing server if it still has the development/repo folder. You do not need `dist\shop-update` for this case.

Use `dist\shop-update` only when you are updating a shop server that does not have Git/repo setup, or when you want to send a prepared package from your personal laptop.

#### Step A: On Your Development PC

Update and test code in your development repo. Then build the update package:

```powershell
cd C:\Users\badis\Downloads\BADIZO_COMPLETE_APPLICATION
.\scripts\windows\build-shop-update-package.ps1 -ServerIp 192.168.1.12
```

This creates:

```text
C:\Users\badis\Downloads\BADIZO_COMPLETE_APPLICATION\dist\shop-update
```

Inside `shop-update`, you should see:

```text
backend
frontend
scripts
apply-shop-update-one-click.bat
Badizo Setup 1.0.0.exe
SHOP_UPDATE.md
```

Send/copy the full `shop-update` folder to the shop server using pen drive, AnyDesk file transfer, Google Drive, or any other method.

#### Step B: On Shop Server PC

1. Close Badizo Electron app on the server.
2. Ask slave users to close Badizo app also.
3. Open the copied `shop-update` folder on the server.
4. Double-click:

```text
apply-shop-update-one-click.bat
```

5. Click Yes when Windows asks for Administrator permission.
6. Wait for the success message.

The update script will:

- Install backend dependencies.
- Install frontend dependencies.
- Build frontend for the server IP.
- Restart backend.
- Restart frontend task.
- Check server health.

After success, these should open on the server:

```text
http://192.168.1.12:3000
http://192.168.1.12:5000/api/health
```

#### Step C: On Slave PCs After Update

If only backend/frontend/server code changed:

```text
Close Badizo app and open it again.
```

If Electron app changed:

```text
Run the newest Badizo Setup 1.0.0.exe on each slave PC.
```

## Case 2: New Shop Setup

Use this when installing Badizo in a new shop.

### New Shop: Prepare Deployment Package

On your development PC, run:

```powershell
cd C:\Users\badis\Downloads\BADIZO_COMPLETE_APPLICATION
.\scripts\windows\build-new-shop-deployment-package.ps1 -ServerIp 192.168.1.12
```

This creates:

```text
C:\Users\badis\Downloads\BADIZO_COMPLETE_APPLICATION\dist\new-shop-deployment
```

Inside `new-shop-deployment`, you should see:

```text
backend
frontend
scripts
setup-new-shop-server-one-click.bat
setup-slave-one-click.bat
setup-slave-app.ps1
Badizo Setup 1.0.0.exe
NEW_SHOP_DEPLOYMENT.md
SERVER_SLAVE_SETUP.md
```

Copy the full `new-shop-deployment` folder to the new shop server PC.

### New Shop: Server PC Setup

On the new shop server PC:

1. Open the copied `new-shop-deployment` folder.
2. Double-click:

```text
setup-new-shop-server-one-click.bat
```

3. Click Yes when Windows asks for Administrator permission.
4. Wait until setup completes.

The server setup will:

- Check/install Node.js LTS using `winget`.
- Check/install/start MySQL where Windows allows it.
- Create database `badizo_pos`.
- Install backend dependencies.
- Install frontend dependencies.
- Install backend auto-start task.
- Install frontend auto-start task.
- Allow firewall ports `3000` and `5000`.
- Start backend and frontend.
- Test server URLs.

After success, these should open on the server:

```text
http://localhost:3000
http://localhost:5000/api/health
http://192.168.1.12:3000
http://192.168.1.12:5000/api/health
```

### New Shop: Do I Need To Manually Install MySQL, Node.js, Database, Tables?

Node.js:

```text
Usually no. The setup script installs Node.js LTS using winget.
```

MySQL:

```text
Maybe one manual step is needed on some Windows PCs.
```

The script tries to install/check/start MySQL. But first-time MySQL setup may open the MySQL installer wizard on some systems. If that happens, complete the wizard with:

```text
MySQL Server 8.x
Windows service enabled
root password: 1234
```

Then run again:

```text
setup-new-shop-server-one-click.bat
```

Database:

```text
No manual database creation is needed if the setup script connects to MySQL.
```

The script creates:

```text
badizo_pos
```

Tables:

```text
No manual table creation is needed.
```

When backend starts, it automatically creates/updates required tables.

### New Shop: Slave PC Setup

On each slave PC, keep these three files in one folder:

```text
setup-slave-one-click.bat
setup-slave-app.ps1
Badizo Setup 1.0.0.exe
```

Double-click:

```text
setup-slave-one-click.bat
```

The slave setup will connect the slave to the new shop server.

### New Shop: Future Updates

Future updates for a new shop are exactly the same as existing shop updates.

On your development PC:

```powershell
cd C:\Users\badis\Downloads\BADIZO_COMPLETE_APPLICATION
.\scripts\windows\build-shop-update-package.ps1 -ServerIp 192.168.1.12
```

Send/copy:

```text
dist\shop-update
```

On shop server:

```text
Open shop-update folder
Double-click apply-shop-update-one-click.bat
```

On slaves:

- If only server code changed, close and reopen Badizo.
- If Electron app changed, run latest `Badizo Setup 1.0.0.exe`.

## Quick Script Summary

Existing shop slave setup:

```text
setup-slave-one-click.bat
```

Existing shop update package build:

```powershell
.\scripts\windows\build-shop-update-package.ps1 -ServerIp 192.168.1.12
```

Existing shop update directly from Git/repo folder:

```text
scripts\windows\update-existing-server-from-git-one-click.bat
```

Existing shop update run on server:

```text
apply-shop-update-one-click.bat
```

New shop deployment package build:

```powershell
.\scripts\windows\build-new-shop-deployment-package.ps1 -ServerIp 192.168.1.12
```

New shop server setup run on server:

```text
setup-new-shop-server-one-click.bat
```

New shop slave setup:

```text
setup-slave-one-click.bat
```
