# Recovery execution and activation

These are opt-in installation features. Normal POS startup does not install the new tables, start a supervisor, change its database or enable synchronization.

## Owner actions

- **Apply saved product choices** applies a saved, fully resolved name/price review locally and queues its corresponding cloud resolution. It rejects edits made after the preview, retains the original review in a transactional audit ledger, and is retry-safe. It does not change stock, discard invoices or authorize a billing switch.
- **Pause billing on this server** stops new business writes and waits for accepted requests to finish.
- **Emergency local billing** reopens the current local database without requiring internet. It records that reconciliation is required and enables local preference for eligible name/price conflicts in the enrolled receiver. Real sales and financial differences are not discarded by this preference.
- **Use cloud emergency billing** is cloud-only and requires the owner to confirm local counters have stopped. It does not remotely fence an unreachable local server or claim that daily backups contain unsent transactions.
- **Use verified restore for local billing** switches to a separately restored and verified database. This is replacement, not merge. The previous database remains intact for later reconciliation.

The local and cloud emergency actions are manual modes. The separate coordinated **Use Cloud / Return to Local** workflow now pauses the previous writer, drains supported pending transfers and verifies peer activation before completing. A lost activation reply leaves the source paused until status is known. Emergency activation remains distinct: it cannot fence an unreachable server or prove that missing source transactions were transferred. Never present emergency activation as “fully synchronized,” and never permit intentional parallel billing.

## Conflict execution

Install `database/migrations/optional-sync-recovery-applications.sql` explicitly alongside the previously required inbox/outbox migrations in an enrolled local database. Configure the protected review directory, shop and installation identities. `BADIZO_RECOVERY_REVIEW_ENABLED=true` enables review routes; `BADIZO_RECOVERY_APPLY_ENABLED=true` enables local execution. The ordinary server refuses execution on cloud nodes.

Use `createPosSyncReceiver` for an enrolled receiver. It includes the supported business handlers and the `pos.recovery.product-resolved` handler. Supply a protected review store locally. Eligible incoming conflicts create immutable reviews linked to their original events. Applying the review records the incoming event receipt in the same transaction as the chosen values and outgoing resolution. Resolution packets include covered older outgoing field edits; receivers retain their hashes as receipts, so those edits cannot undo the chosen result. The sender prioritizes these resolution packets to prevent an older conflicting edit from blocking them indefinitely. Both queues can then acknowledge their original events normally.

Only name/price conflicts qualify for this bulk product-choice path. Separate audited stock and supplier-payment correction tools handle their supported cases; they do not discard genuine sales or treat arbitrary financial differences as a local/cloud overwrite. Product creation/deletion and unresolved purchase dependencies can still block transfer. The review executor does not itself provision peer credentials.

## Runtime binding and supervisor

Provision one protected runtime binding JSON per installation. It contains `schemaVersion:1`, `shopId`, a UUID `activationId`, nonnegative `generation`, `phase` (`active` or `validating`), `billingMode` (`active` or `standby`), and `database:{host,user,password,database}`. The host must be loopback. Initialize it from the actual current database, not a guessed default. Cloud starts in standby. Protect it and the supervisor directory with OS permissions; never put either in Git, Google Drive or a browser response.

Set `BADIZO_RUNTIME_BINDING` to its absolute path in the POS service environment. Startup loads this connection for both SQL and subsequent backup operations. It disables schema bootstrap for recovery-bound databases. The runtime gate refuses writes when the binding is validating, paused, corrupt or different from the process's startup binding. Readiness reports the activation ID and active write-request count, never credentials.

The supervisor configuration is a protected JSON file containing:

- `shopId` and `nodeRole` (`local-server`, `cloud-standby` or `cloud-active`).
- Absolute `directory`, `bindingPath`, `restoreConfigPath`, and `restoreJobDirectory` paths.
- `readyUrl`, restricted to the local `/api/ready` endpoint.
- Fixed `stop` and `start` commands, each `{file:absoluteExecutablePath,args:[...]}`. These must control only this installation's POS service. They are executed without a shell; HTTP requests cannot supply commands or paths.
- Optional `healthTimeoutMs` (default 30 seconds).

Set `BADIZO_RECOVERY_CONTROL_CONFIG` to this file in the POS environment. Install `tools/fleet/recovery-supervisor.cjs CONFIG_PATH` as a **separate OS service**, outside the POS service process group. It must remain running when it stops/restarts POS. Use the backend's Node dependencies. The API refuses new operations when its heartbeat is stale.

Build the owner UI with `REACT_APP_RECOVERY_REVIEW_ENABLED=true`, `REACT_APP_STAGED_RESTORE_ENABLED=true` and `REACT_APP_RECOVERY_CONTROL_ENABLED=true`. They remain off unless explicitly configured.

## Activation safety

Before activation, the supervisor verifies the job belongs to the shop, the configured target is a separate `badizo_recovery_*` database, MySQL is 8.0, required tables are InnoDB and counts still match the verified job. It then saves the previous binding privately, freezes writes and waits for the running POS to drain. A drain timeout restores the previous mode without terminating in-flight work.

It stops POS using the configured service command, installs the candidate binding in validating mode, and restarts POS. The candidate must report the exact activation UUID before writes are opened. Failed startup restores the previous binding and restarts the previous POS. No database is dropped.

The durable operation journal distinguishes pre-activation failure from a committed activation. Once a new database has been opened for billing, automatic rollback is prohibited because it may contain new sales. A restart after the commit records completion rather than silently reverting those sales.

Failed rollback leaves billing paused for inspection. After an abrupt supervisor crash, inspect the journal and ensure the previous supervisor process is dead before clearing its exclusive `supervisor.lock` and restarting it. Do not clear locks or replace the active binding blindly. Background database writers must be paused by the enrollment/runtime integration during activation; the HTTP gate alone is not a lock for arbitrary external SQL clients.

## Validation and deployment boundary

The isolated MySQL/API drills exercised manual local/cloud conflict choices, automatic emergency local preference, stale-preview rejection, retry deduplication and both blocked queues draining after resolution. The activation drill used the actual POS process on a separate port, tested owner HTTP controls, cloud-standby activation, paused writes, real MySQL candidate verification, failed-start rollback and persistence across process restart. Original production databases and services were not switched.

Shop rollout still requires the actual Windows service identity/start-stop behavior, process ownership, MySQL configuration, protected-file permissions, backup destination and physical printers/counters to be checked. Do not enable these controls against the shop database until those installation checks pass. Promotions and loyalty remain outside the requested supported recovery profile. Import coverage and older-backup recovery require their own acceptance evidence; these activation drills do not certify the entire product as production-ready.
