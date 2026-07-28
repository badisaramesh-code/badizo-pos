# Badizo POS one-click production workflow

## Purpose

`BADIZO_ONE_CLICK_FULL_SYNC_AND_RESTART.bat` is the double-click entry point for safely backing up, synchronizing, committing approved source changes, updating dependencies when required, building when required, pushing, restarting, verifying, and opening the production Badizo POS server application.

The launcher requests Administrator rights because the verified production backend is a Windows service. The PowerShell window remains open on both success and failure. Do not run the workflow for the first time until its detected setup and safeguards have been reviewed and approved.

## Detected production setup

- Project root: `D:\badizo-pos-main`
- Git branch: `main`
- Git remote: `origin` = `https://github.com/badisaramesh-code/badizo-pos.git`
- Backend service: automatic Windows service `BadizoServer`, wrapped by `C:\BadizoService\nssm.exe`
- NSSM application: `C:\Program Files\nodejs\node.exe`
- NSSM working directory: `D:\badizo-pos-main\backend`
- NSSM arguments: `server.js`
- Backend/API and production frontend: `backend/server.js` listens on port 5000 and serves `frontend/build`; `/api/health` returns `{"ok":true}`
- Compatibility port: the same backend process listens on port 3000 and redirects application traffic to port 5000
- Database backup: scheduled task `Badizo Daily Drive Backup` runs `node.exe D:\badizo-pos-main\backend\scripts\badizo_cloud_backup.js daily`. Its latest inspected run succeeded and produced a validated SQL dump under `D:\BadizoCloudBackups\daily`.
- Server UI launcher: Desktop shortcut `Badizo Server.lnk` opens Microsoft Edge in app mode at `http://127.0.0.1:5000`
- Electron: source and packaging configuration exist, but `C:\Users\SERVER\AppData\Local\Programs\Badizo\Badizo.exe` was not installed on the inspected server. Therefore this server workflow uses the actual Edge app-mode launcher and does not build or launch Electron.

The automation validates the service, task, remote, branch, and desktop shortcut against these detected values every run. A mismatch stops the workflow rather than guessing.

## Exact sequence

1. Require the exact project directory and create a timestamped transcript in `logs\one-click`.
2. Show Git status; verify branch `main`, remote `origin`, and the approved GitHub URL.
3. Refuse an existing merge, rebase, cherry-pick, revert, or unresolved conflict.
4. Inspect Git-visible changes for forbidden secret/dump filenames and obvious private-key or service-account content.
5. Refuse tracked changes outside the source/configuration allowlist.
6. Run the verified `Badizo Daily Drive Backup` task and require a successful, newly created SQL dump larger than 1 MB.
7. Copy existing production configuration files to `D:\BadizoCloudBackups\pre-update-config\<timestamp>` without printing their contents.
8. Fetch `origin`, then print incoming and outgoing commits.
9. Print local safe source/configuration files, stage each file explicitly, print the exact staged list, scan again, and create a timestamped automatic commit.
10. Pull using `git pull --rebase origin main`; stop on conflict without reset, abort, force, or deletion.
11. Run `npm ci` only in backend, frontend, or Electron when that area’s `package.json` or `package-lock.json` changed.
12. Build the frontend only when tracked frontend files changed or `frontend/build/index.html` is missing. Post-build auto-open is disabled.
13. Push normally to `origin main` only when outgoing commits exist. Force push is never used.
14. Validate the actual NSSM parameters and restart only `BadizoServer`.
15. Require health HTTP 200 with `{"ok":true}` and verify that the service PID owns port 5000.
16. If the verified Edge app-mode process already exists, do not start another. Otherwise open `Badizo Server.lnk`.
17. Verify the application URL, show final Git status, show the latest three commits, and print `BADIZO READY` or `BADIZO NOT READY - REVIEW REQUIRED`.

## Staging safety policy

The script uses an extension allowlist for source code, scripts, documentation, and configuration. It explicitly excludes `.env` files, credential/service-account JSON, private keys, SQL/dump files, archives, executables, installers, logs, `node_modules`, build/dist/coverage folders, backup folders, and other generated artifacts.

Ignored production files such as `backend/.env` remain untouched. Their contents are never printed. Configuration backup copies are written outside the repository.

## Failure behavior

Any mismatch, backup failure, unsafe tracked change, secret detection, Git conflict, install/build failure, push failure, service mismatch, failed health check, duplicate-risk condition, or application-launch failure stops the workflow and prints:

`BADIZO NOT READY - REVIEW REQUIRED`

The workflow never runs `git reset --hard`, never force-pushes, never restores or modifies MySQL data, and never deletes production data. The existing backup task retains backups according to its already-configured production retention policy.

## First test

After approval, double-click `BADIZO_ONE_CLICK_FULL_SYNC_AND_RESTART.bat`. Keep the resulting log and review any red failure message before taking manual action.
