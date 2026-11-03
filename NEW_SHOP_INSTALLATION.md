# Badizo POS: new shop server and slave installation

Use this guide for a **new shop**. The server holds the shop database and runs the backend; counter, admin and security PCs connect to it over LAN. Each shop needs its own server database and settings.

## 1. Prepare the latest installation package

Do this on the development/build PC before visiting the shop. A Git checkout contains source code; it is not a ready-to-run offline installer. Do not use the older dated EXE/setup folders in this repository for a new release.

Prerequisites: Windows build PC, Git, Node.js/npm and internet for dependency installation. In PowerShell at the repository root, use these commands after committing or preserving any local work:

```powershell
git pull --ff-only origin main
npm ci --prefix backend
npm ci --prefix frontend
npm ci --prefix electron
$env:BADIZO_SKIP_OPEN_AFTER_BUILD = '1'
npm --prefix frontend run build
npm --prefix electron run dist
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\windows\build-offline-new-store-package.ps1 -CreateZip
```

Run each command only after the preceding command succeeds. The package builder uses the frontend build and the newest installer in `electron\dist`; rebuild both for the current release. It requires a new output folder; use -OutputDir with a new release folder when rebuilding.

Outputs:

- `output\BADIZO_NEW_STORE_OFFLINE_PACKAGE\`
- `output\BADIZO_NEW_STORE_OFFLINE_PACKAGE.zip`

Copy the **whole folder**, including `payload`, onto a USB drive. Also take this guide and a MySQL Server installer. The package includes Node.js and backend dependencies, but **does not install MySQL Server**. The optional PDF guide is included only if it already exists in `output\pdf`.

## 2. Prepare the new shop LAN

1. Connect the server and all slaves to the same router/switch, preferably with LAN cables.
2. The current installer is fixed to server IP **192.168.1.10**. Ensure the shop LAN supports this address and that no other device uses it. Reserve it in the router.
3. Slaves need their own unique IP addresses on that LAN; do not assign the server IP to a slave.
4. If the shop uses another subnet, have the technician adapt the server/client installer configuration first. Merely changing the IP on a slave will not adapt the fixed server installer.
5. Keep the server powered on while slaves are operating. Internet is needed for cloud backup authorization/uploads, but the installed POS communicates with the server over the local network.

## 3. Install the SERVER PC

Use a new installation, not this procedure as an upgrade over a live shop. The installer writes server configuration and uses the database name `badizo_pos`; an existing database of that name is not automatically cleared.

1. Install and configure **MySQL Server 8.0 on port 3306**, including its Automatic Windows service and command-line tools. Set/reserve server IP 192.168.1.10 before running setup. Record the MySQL username/password.
2. Copy/extract the complete offline package to a local folder. Do not run inside the ZIP.
3. Run `RUN_BADIZO_NEW_STORE_INSTALL.bat`.
4. Select **1. SERVER PC**, then allow the Windows administrator prompt.
5. Enter the MySQL username (default prompt: `root`) and the password configured for this new shop.
6. Wait for the success message and the Badizo desktop installation to finish.

The installer:

- Creates/uses `badizo_pos` and installs files under `C:\BadizoPOS`.
- Writes this shop's database credentials to `C:\BadizoPOS\backend\.env`.
- Verifies the prepared server already has `192.168.1.10`; preserves network settings.
- Registers the **Badizo POS Backend** Windows startup task and firewall rules.
- Starts the backend and verifies database schema readiness, API health and frontend through `http://192.168.1.10:5000`.
- Installs the **Badizo POS** desktop shortcut.
- Configures local backup storage at `D:\BadizoPOSBackups` when D: exists, otherwise `C:\BadizoPOSBackups`, with a configured daily time of 22:30.

Open the Badizo POS desktop shortcut. On a fresh database the seeded server login is `server` / `server123`; change initial passwords in System before live use. Configure this shop's name, address, GST, phone, counters and users in **System → Open Setup Folder**. Do not restore another shop's live database just to obtain its products; use the intended product-import workflow instead.

## 4. Install the SLAVE PCs

Repeat on every counter, admin or security PC:

1. Keep the server running and connect this PC to the same LAN.
2. Copy/extract the **same complete offline package** onto this PC.
3. Run `CHECK_BADIZO_LAN.bat`. Confirm port 5000 and API health pass.
4. Run `RUN_BADIZO_NEW_STORE_INSTALL.bat` and choose the correct role:

| Menu option | Computer |
| --- | --- |
| 2. COUNTER PC | Billing counter |
| 3. ADMIN PC | Admin workstation |
| 4. SECURITY PC | Security/gate workstation |

5. Complete the desktop installation and open **Badizo POS**.
6. Log in with the appropriate shop account. Use a distinct counter account for each billing counter, for example counter1 and counter2, configured in System.

The slave setup connects to `http://192.168.1.10:5000`. Slaves do **not** need MySQL, the Git repository, or a separately running backend/frontend. Do not select SERVER on a slave.

For a technician who wants to preselect a login, run from the package folder:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\payload\setup-slave-app.ps1 -ServerIp 192.168.1.10 -LoginMode counter -LoginUser counter1 -InstallerPath '.\payload\Badizo Setup 1.0.0.exe'
```

Change the role/account for each PC. Preselecting a username does not create that account or set its password.

## 5. Printers and backup

- Install the printer's Windows driver on the PC that prints, and verify a Windows test page first.
- Set up receipt and barcode printing using [THERMAL_PRINTER_SETUP_GUIDE.md](THERMAL_PRINTER_SETUP_GUIDE.md) and [BARCODE_STICKER_SETUP_GUIDE.md](BARCODE_STICKER_SETUP_GUIDE.md).
- Verify one thermal receipt, one A4 bill, one quotation and a multi-page Local/Non-Local PDF before live billing.
- Use **System → Backup Now** and confirm the backup file was actually created. Keep a copy outside the server PC and test restore in a separate test installation.
- Google Drive backup starts disabled in the new-shop installer. On the server, run `CONFIGURE_GOOGLE_DRIVE_BACKUP.bat` with this shop's OAuth client details and Drive folder, then complete authorization. See [GOOGLE_DRIVE_BACKUP_SETUP_GUIDE.md](GOOGLE_DRIVE_BACKUP_SETUP_GUIDE.md).
- The configuration script restarts the backend after authorization. Verify an actual cloud upload before relying on it.

## 6. Final handover checks

- Restart the server and confirm the backend starts automatically.
- Run `CHECK_BADIZO_LAN.bat` on each slave after restart.
- Confirm products, stock and bills are shared through the server.
- Make a test bill at each counter and verify its counter number and invoice sequence.
- Check shop details and printer settings on the actual printed outputs.
- Confirm local backup and, if enabled, Google Drive upload.
- Record the installed Git commit, server IP, PC/counter assignments and backup location. Store passwords securely outside Git.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| `payload` missing | Copy/extract the entire package, not just the BAT or EXE. |
| MySQL not found / login failed | Complete MySQL Server configuration; verify its service and credentials. |
| Server health fails | Check MySQL and the Badizo POS Backend task; inspect `C:\BadizoPOS\backend\logs\server.err.log`. |
| Server works but slave fails | Check LAN cable, same subnet, unique IPs, server port 5000 and firewall. Run the LAN checker. |
| Wrong role/user displayed | Rerun the matching slave role setup; verify the account in System. |
| Need another server IP | Adapt both installer and client configuration; the menu currently assumes 192.168.1.10. |

This guide documents the existing scripts. It does not mean a fresh-shop installation has been tested on a separate physical server and slave PC.
