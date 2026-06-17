# Badizo New Shop Deployment

This is the simplest recommended flow when setting up Badizo in another shop.

## Can Node.js and MySQL be installed in one click?

Node.js can be installed automatically by the setup script using Windows `winget`.

MySQL can also be started/configured automatically after it is installed. The script will try to install MySQL using `winget`, but first-time MySQL setup may still open the MySQL installer wizard on some Windows systems. If that happens, complete the wizard with:

- MySQL Server 8.x
- Windows service enabled
- root password: `1234`

After that, run the same setup again. It will create the `badizo_pos` database and continue.

## Prepare Package Before Going to Shop

Run this on your development/server computer:

```powershell
cd C:\Users\badis\Downloads\BADIZO_COMPLETE_APPLICATION
.\scripts\windows\build-new-shop-deployment-package.ps1 -ServerIp 192.168.1.12
```

The package will be created here:

```text
C:\Users\badis\Downloads\BADIZO_COMPLETE_APPLICATION\dist\new-shop-deployment
```

Copy that full folder to the new shop server PC.

## Server PC One Click

On the shop server PC:

1. Open the copied `new-shop-deployment` folder.
2. Double-click `setup-new-shop-server-one-click.bat`.
3. Click Yes when Windows asks for Administrator permission.
4. Wait until the setup checks show success.

This script will:

- Check/install Node.js LTS using `winget`.
- Check/install/start MySQL where Windows allows it.
- Create the `badizo_pos` database.
- Install backend and frontend auto-start tasks.
- Allow firewall ports `3000` and `5000`.
- Start backend and frontend.
- Test server URLs.

After success, test these on the server:

```text
http://localhost:3000
http://localhost:5000/api/health
http://192.168.1.12:3000
http://192.168.1.12:5000/api/health
```

## Slave PC One Click

On every slave PC, copy these three files from the package into one folder:

```text
setup-slave-one-click.bat
setup-slave-app.ps1
Badizo Setup 1.0.0.exe
```

Then double-click:

```text
setup-slave-one-click.bat
```

The slave setup will:

- Check that the server frontend is reachable at `http://192.168.1.12:3000`.
- Check that the server backend is reachable at `http://192.168.1.12:5000/api/health`.
- Install the Badizo Electron app.
- Configure the Electron app to use the server over LAN.
- Launch Badizo.

## Important

If the shop server IP is different, edit the `SERVER_IP` line inside these `.bat` files before running:

```bat
set "SERVER_IP=192.168.1.12"
```

Use the actual server IP of that shop.
