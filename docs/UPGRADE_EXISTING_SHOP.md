# Upgrade the other shop’s Windows POS

Use the **server PC at the shop you are upgrading**. Set aside a maintenance window and keep the previous working version available until a counter has verified the update.

1. **Before closing:** Sign in as `server`. Look under **System → Software maintenance**. If it shows an **Approved release**, compare it with the Git commit selected for the rollout. If the button is absent or shows a setup message, identify how the server starts using the section below.
2. **At closing:** Finish pending bills on every counter, note the last invoice number and daily sales total, and close the counters. Take a fresh backup of this shop’s database. Check that it restores into a separate test database. Keep the previous application, its startup configuration, the shop’s environment file, and the printer and backup settings. Keep a copy of the backup outside the server.
3. **If an approved update is available:** Select **Update software** in **System → Software maintenance** and wait for completion. Use the legacy steps below only for a confirmed Git installation run by the Windows scheduled task.
4. **Before reopening:** From one counter, reopen the POS and check the shop name, latest invoice, daily total and an item’s price and stock. Reprint the last receipt and check the printer and layout. Verify that the server is actually serving the new version. Then reopen the other counters. Confirm the next scheduled shop backup succeeds.

## Older Git installation with the “Badizo POS Backend” task

Open **PowerShell as Administrator** in the running installation’s Git folder. These first commands identify what you are updating.

```powershell
(Get-ScheduledTask -TaskName 'Badizo POS Backend').Actions |
  Format-List Execute,Arguments,WorkingDirectory
git status --short --branch
git remote get-url origin
git rev-parse HEAD
```

Check that the startup task points to this checkout, that the branch is `main`, and that the remote is the expected `badisaramesh-code/badizo-pos` repository. Record the current commit. If local source changes appear, inspect them before updating. If Windows starts POS through a service, or the running files are under another release folder, use the installed release’s update procedure instead.

After backup verification and counter closure, run each command separately. Stop on an error. Replace the IP placeholder with **this shop server’s actual LAN IP**.

```powershell
git pull --ff-only origin main
git rev-parse HEAD
& .\scripts\windows\update-badizo-app.ps1 -SkipGitPull -ServerIp '<shop server LAN IP>'
```

Compare the printed commit with the intended release before running the update script. This script installs dependencies, builds the frontend, and restarts the backend. Watch for errors during installation and build. Its final health check alone cannot prove that the new application is running. The older Git update BAT file assumes `192.168.1.9`; that address may belong to a different installation.

## If verification fails

Keep counters closed and record the error. If enrolled maintenance offers **Return to previous version**, use it according to the shop’s rollback procedure. The legacy updater has no automatic rollback: have the installer restore the saved application and launcher after checking database compatibility. Restoring an older database after sales resume would remove transactions made since the backup.

An installation already using the protected release launcher has a separate plan, apply and interrupted-upgrade recovery procedure in `docs/WINDOWS_ENROLLED_UPGRADES.md`. A Git pull in a separate source checkout does not deploy an installed Windows service.
