# Windows POS release upgrades

This upgrades the POS application, not Windows or MySQL. It is a separate opt-in workflow for shops already configured with a protected runtime binding and the release-pointer launcher. Existing startup tasks and the legacy updater are not modified automatically.

## Release preparation

On Windows x64 with Node 24, use a clean checkout of the exact reviewed commit, install backend dependencies from its lockfile, and install frontend build dependencies. Run:

```powershell
node tools/fleet/build-windows-release.cjs FULL_40_CHARACTER_COMMIT C:\ReleaseOutput\UniqueReleaseFolder
```

The builder rejects a dirty checkout, copies tracked application and sync migration files, copies runtime dependencies and builds the frontend. The output contains a per-file SHA-256 manifest. It excludes credentials, environment files, database dumps and operational logs. Treat the release's provenance as trusted separately: checksums detect changes but are not a publisher signature. Do not distribute development `.env` files or a shop database with the package.

Build from a dedicated checkout without frontend `.env`, `.env.local`, `.env.production`, or `.env.production.local`; the builder refuses these files before creating output. Ambient `REACT_APP_*`, `PUBLIC_URL`, and build-path overrides are cleared, and only the release's explicit recovery feature flags are supplied. This prevents private development settings from being embedded in public JavaScript. Shop-specific configuration belongs in the protected runtime setup.

## One-time shop onboarding

During the planned shop visit, verify and preserve the actual Windows service/scheduled-task commands, shop environment file, MySQL 8.0 runtime, database binding, printer settings, existing manual-backup directory and daily Drive backup configuration. Configure the service to run `tools/fleet/run-windows-release.cjs` with a protected launcher JSON. That file names `root`, `shopId`, `environmentFile`, `bindingPath`, and `manualBackupDirectory`. All paths are absolute. The last property must point to the existing backup location so moving application releases does not relocate old backups. External configuration and DB-stored printer/backup settings are never bundled or overwritten.

The initial `root/current-release.json` points to a verified existing release under `root/releases/<commit>` and contains `commit` and `directory`. This initial adoption cannot safely be inferred from an unknown live shop layout. Protect the root, runtime binding, configuration and MySQL defaults file with Windows ACLs restricted to the service and installer identities.

The installer JSON names `root`, `shopId`, `bindingPath`, `dbConfigPath`, `dumpExecutable`, `dumpDefaultsFile`, `readyUrl`, and four fixed command objects: `stop`, `start`, `stopSupervisor`, `startSupervisor`. Each command is `{ "file": "absolute executable path", "args": ["fixed", "arguments"] }`. Commands must actually stop/start the relevant task and its child process; checking that behavior belongs in shop onboarding. The dump defaults file holds MySQL credentials; passwords are not passed on the command line. The database JSON is the separate installer account configuration described in SYNC_SCHEMA_INSTALLER.md.

## Applying and recovering

```powershell
node tools/fleet/upgrade-windows-release.cjs C:\Protected\upgrade.json --plan C:\ReleaseOutput\ReleaseFolder
scripts\windows\upgrade-enrolled-pos.bat C:\Protected\upgrade.json C:\ReleaseOutput\ReleaseFolder
node tools/fleet/upgrade-windows-release.cjs C:\Protected\upgrade.json --recover
```

Plan checks package bytes and database migrations without changing the application. Apply stages the new release beside the old one, stops the recovery supervisor, blocks and drains POS writes, creates and hashes a completed MySQL dump, stops the POS, applies only verified additive sync migrations, changes the release pointer, and starts the candidate while writes remain blocked. Readiness must identify the expected shop, database activation and release commit before billing reopens.

If candidate startup fails before billing reopens, the old binary is restarted against the same database. No database backup is automatically restored and no newer transactions are discarded. Old releases and backup evidence are retained. A crash leaves durable upgrade state; explicit recovery checks that the original process no longer exists before reclaiming its lock. If the new release already opened billing, recovery completes its journal instead of rolling back a potentially used release.

These scripts do not upgrade Windows, change printer configuration, enable cloud sync, install Node/MySQL, or silently convert a legacy shop's startup layout. The filesystem/rollback tests run with synthetic releases; actual Windows service and printer acceptance still requires the shop configuration and hardware.
