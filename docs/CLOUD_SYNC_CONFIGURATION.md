# Cloud sync schedule configuration

The local POS System screen has a separate Cloud Sync panel. A Server user can save Daily or Hourly frequency and change the daily time without editing application code. Admin users can view it; Counter and Security users have no access. Daily defaults to **20:30 Asia/Kolkata (8:30 PM IST)**. Hourly means the start of each hour in IST. Switching frequency retains the saved daily time.

This change implements schedule preferences and validation, not database transfers. Until the incremental transfer worker and shop-to-cloud connection are configured, the panel says **Cloud sync not configured**, automatic sync cannot be enabled, no next run is advertised, and Update Cloud Now is disabled. Saving a preference is never represented as a successful sync. Neither Windows backup tasks nor Google Drive uploads are changed.

## Per-installation storage

Preferences live in `<OS-user-home>/BadizoCloudSync/schedule.json`, outside MySQL, so restoring or replicating a database cannot overwrite the receiving machine's schedule. The local server process account must retain access to this directory. A deployment can select a durable installation-specific directory through `BADIZO_CLOUD_SYNC_CONFIG_DIR`. Do not share this directory between shops or cloud and local installations. No SQL credentials or cloud credentials are stored in the schedule file.

`BADIZO_NODE_ROLE=local-server` permits schedule changes (the compatibility default). Set cloud deployments explicitly to `cloud-standby` or `cloud-active`; cloud nodes cannot edit a local schedule. This setting is separate from a user's SERVER login role.

API routes:

- `GET /api/cloud-sync/settings`: SERVER or ADMIN.
- `POST /api/cloud-sync/settings`: SERVER only, complete payload `{enabled:false,frequency:"daily",dailyTime:"20:30",timezone:"Asia/Kolkata"}`.

## Connection to the future worker

The transfer worker must consume this persisted configuration, reload it after saves or on each scheduling check, and supply `getWorkerState` only after secure connectivity, shop identity and single billing authority are verified. It must refuse incoming local changes while cloud billing is active, prevent overlapping manual/scheduled jobs, preserve transfer checkpoints, retry failed runs, and report an actual successful sync timestamp. A schedule preference alone never grants permission to accept billing writes or overwrite cloud data.

`nextScheduledAt` is a tested schedule calculator for the worker; there is no background timer or transfer in this delivery. Missed-run catch-up and checkpoint retention belong to the worker, not this UI. Once the worker is connected, frequency/time changes must be read from these settings without a code change or server restart.

Existing daily full SQL backups to Google Drive remain independent. Start Hyper Fresh Mart with Daily at 20:30 IST. Hyper Fresh Mart 2.0 requires its own configuration and credentials later. The development laptop is not the production sync source.

## Deployment status

These source changes have not been installed on the running shop servers or the staged Lightsail release. No production schedule, backup task, printer configuration or database was modified by adding this panel.
