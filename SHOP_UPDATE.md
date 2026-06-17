# Badizo Shop Update

Use this flow when Badizo is already installed in a shop and you want to send a new version.

## Developer Computer

1. Update and test the code in your development repo.
2. Commit and push the code.
3. Build an update package:

```powershell
cd C:\Users\badis\Downloads\BADIZO_COMPLETE_APPLICATION
.\scripts\windows\build-shop-update-package.ps1 -ServerIp 192.168.1.12
```

The package will be created here:

```text
C:\Users\badis\Downloads\BADIZO_COMPLETE_APPLICATION\dist\shop-update
```

Send the full `shop-update` folder to the shop.

## Shop Server PC

1. Close the Badizo Electron app on server and slave PCs.
2. Copy the new `shop-update` package contents into the existing Badizo app folder on the server.
3. Double-click:

```text
apply-shop-update-one-click.bat
```

4. Click Yes when Windows asks for Administrator permission.
5. Wait for the success message.

The update script will:

- Skip Git pull.
- Install backend/frontend dependencies.
- Build frontend for the shop server IP.
- Restart backend.
- Restart frontend task.
- Check:

```text
http://192.168.1.12:3000
http://192.168.1.12:5000/api/health
```

## Slave PCs

If the update includes Electron app changes, copy the newest `Badizo Setup 1.0.0.exe` from the update package to each slave and run it.

If only backend/frontend server code changed, slave PCs usually do not need reinstall. Close and reopen the Badizo app after the server update.

## Important

If the shop server IP is different, edit the `SERVER_IP` line inside `apply-shop-update-one-click.bat` before running:

```bat
set "SERVER_IP=192.168.1.12"
```
