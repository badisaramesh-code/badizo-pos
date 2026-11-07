# Cloud sync schedule configuration

The local POS System screen has a separate Cloud Sync panel. A Server user can save Daily or Hourly frequency and change the daily time without editing application code. Admin users can view it; Counter and Security users have no access. Daily defaults to **20:30 Asia/Kolkata (8:30 PM IST)**. Hourly means the start of each hour in IST. Switching frequency retains the saved daily time.

The panel is connected to the durable incremental worker for verified, enrolled installations. Until that worker and shop-to-cloud connection are configured, the panel says **Cloud sync not configured**, automatic sync cannot be enabled, no next run is advertised, and Update Cloud Now is disabled. Saving a preference is never represented as a successful sync. Neither Windows backup tasks nor Google Drive uploads are changed.

## Per-installation storage

Preferences live in `<OS-user-home>/BadizoCloudSync/schedule.json`, outside MySQL, so restoring or replicating a database cannot overwrite the receiving machine's schedule. The local server process account must retain access to this directory. A deployment can select a durable installation-specific directory through `BADIZO_CLOUD_SYNC_CONFIG_DIR`. Do not share this directory between shops or cloud and local installations. No SQL credentials or cloud credentials are stored in the schedule file.

`BADIZO_NODE_ROLE=local-server` permits schedule changes (the compatibility default). Set cloud deployments explicitly to `cloud-standby` or `cloud-active`; cloud nodes cannot edit a local schedule. This setting is separate from a user's SERVER login role.

API routes:

- `GET /api/cloud-sync/settings`: SERVER or ADMIN.
- `POST /api/cloud-sync/settings`: SERVER only, complete payload `{enabled:false,frequency:"daily",dailyTime:"20:30",timezone:"Asia/Kolkata"}`.
- `POST /api/cloud-sync/run`: SERVER only; accepts a manual request, not a completed transfer.

## Worker and progress display

The composed worker reads the saved schedule, verifies its enrolled peer and transfers supported events with durable acknowledgements. It prevents overlapping worker runs, retains failed events for retry and reports an actual successful sync timestamp. Normal coordinated handoff pauses billing and transfers before activating the selected writer. A schedule preference alone never grants permission to accept billing writes or overwrite cloud data.

`nextScheduledAt` is the worker's schedule calculator. Frequency/time changes are read without a code change or server restart. The progress bar moves while queued, waiting or transferring; it deliberately does not invent a percentage or item count. A full bar means the last worker run was confirmed complete, not that no new sales have happened since then. The timestamp remains visible. Retries and unavailable status do not show completion. Polling continues through temporary connection/setup failures and clears refresh errors after a successful response, without replacing unsaved schedule edits.

Existing daily full SQL backups to Google Drive remain independent. Start Hyper Fresh Mart with Daily at 20:30 IST. Hyper Fresh Mart 2.0 requires its own configuration and credentials later. The development laptop is not the production sync source.

## Deployment status

These source changes have not been installed on the running shop servers or the staged Lightsail release. No production schedule, backup task, printer configuration or database was modified by adding this panel.
