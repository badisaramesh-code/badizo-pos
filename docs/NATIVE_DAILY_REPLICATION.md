# Daily whole-database delta sync

This is an **opt-in implementation**, not a production enrollment. It has not changed the shop service, database, cloud, tunnel, scheduled tasks or settings. The original application-event sync remains the default. Google Drive full backups remain independent.

## What a daily run does

The separate native agent reads the existing Cloud Sync daily schedule. At the scheduled IST time, or when SERVER chooses **Update Cloud Now**, it:

1. Verifies local billing authority and cloud standby authority, including shop, activation ID, generation, database name/port, and restore invalidation flags. Both application-event runtimes must be absent.
2. Stops the reviewed cloud channel, samples the local source's committed binary-log endpoint with metadata queries, and saves that exact target to `native-run.json` before starting anything.
3. Starts the MySQL receiver and SQL applier with `UNTIL SOURCE_LOG_FILE / SOURCE_LOG_POS`. MySQL stops applying at that endpoint while newer local sales continue.
4. Confirms the **exact applied coordinate**, stops both threads, and durably records the completed checkpoint. Optional transfer history cannot prevent that functional checkpoint from being saved. A connection, received log, or stopped thread is not proof of completion.

The source performs no business-table comparison scans. Cloud applies the changes. This does not promise zero resource cost: validate checkout latency and tunnel throughput under normal billing before activation. A backlog can require more I/O than an ordinary daily run.

The agent polls control state every five seconds; it does not continuously stream sales between daily runs. Missed runs catch up from the last applied position rather than replaying separate daily copies. The GUI keeps the daily time, owner-only manual update and existing Pause/Resume controls.

## Pause and recovery rules

- Pause persists even if cloud is unreachable. The UI distinguishes **pause requested** from confirmed stopped threads.
- A paused partial run retains its original target and does not claim success. Resume/restart continues that target, not a newly sampled endpoint.
- Missing logs, SQL errors, a changed source sequence, overshoot, corrupt state, stale heartbeat or changed authority block further work. The code never resets replication, skips a transaction or silently establishes a new baseline.
- Any `native-invalidation.json` file blocks new work, including an incomplete/corrupt marker. Uploaded-backup recovery also sets `nativeReplicationInvalidated` and creates a new activation/generation.
- Cloud recovery uses `withNativeRecoveryFence` on a dedicated MySQL connection. It holds `badizo-native:<shopId>`, validates the pinned channel, stops both threads, then calls trusted recovery code while the same advisory lock remains held. Ordinary sync starts hold the same lock and verify authority again under it.
- The recovery caller must provide an `isCommitted` callback based on durable activation evidence. A proved precommit failure restores and verifies both read-only flags; a proved committed activation remains writable. An uncertain commit requires inspection and never triggers an automatic rollback or read-only transition.
- Recovery must not restart MySQL while relying on that advisory lock; a MySQL restart releases locks. POS service restart is separate.
- After either database is replaced, or cloud billing is promoted, automatic sync stays blocked until a fresh baseline and both identities have been verified. There is no automatic two-way merge or failback.

## Required one-time provisioning

An installer must perform and record all of the following during a controlled setup window. The agent deliberately does not provision privileges or create a replica from a browser request.

- Matching supported MySQL 8.0 versions, distinct server IDs/UUIDs, and an exact consistent baseline with source file/position, SHA-256 and an isolated restore/reconciliation test.
- Source `log_bin=ON`, `binlog_format=ROW`, `binlog_row_image=FULL`, and at least 30 days of log retention, with disk monitoring. Do not guess a source position from backup time.
- Exactly one named, file-position replication channel (`SOURCE_AUTO_POSITION=0`). Persist **skip-replica-start**, one SQL applier, `read_only` and `super_read_only` in the cloud MySQL startup configuration. Runtime-only settings are insufficient after restart.
- Persist an exact `replicate-do-db=<channel>:<POS database>` and escaped `replicate-wild-do-table=<channel>:<POS database>.%`. For `badizo_pos`, the wildcard must escape the underscore (`badizo\_pos.%`). Source application migrations must select the POS database; review cross-database DDL separately.
- A locked, dedicated `PRIVILEGE_CHECKS_USER` with only `REPLICATION_APPLIER` globally and the reviewed privileges on the POS database. No inherited roles, global administrative privileges, other database access, or grant option. Set `REQUIRE_ROW_FORMAT=1` and `REQUIRE_TABLE_PRIMARY_KEY_CHECK=OFF`; the latter avoids requiring global session-administration privileges.
- This privilege profile requires `partial_revokes=OFF` and an exactly escaped database grant. For `badizo_pos`, `SHOW GRANTS` must show `badizo\_pos`, not the raw underscore wildcard `badizo_pos`. The controller rejects the broader raw grant; the isolated MySQL drill verifies both cases.
- A dedicated controller account with replication-control/status permissions plus read visibility for `performance_schema.replication_applier_configuration` and `SHOW GRANTS` for the pinned applier. It must not be the web application account. The source metadata account needs only metadata/replication-client access.
- A private, host-key-pinned SSH tunnel. MySQL and readiness connections in the agent configuration must terminate on fixed loopback endpoints. Do not expose MySQL publicly. Prove emergency SERVER login and the recovery management path while the cloud data instance is read-only before activation.
- Existing protected local/cloud recovery bindings and `/api/ready` metadata must match the verified database endpoints. Native replication and the application event applier may not be enabled together.

The POS receives **only** the non-secret control directory via `BADIZO_NATIVE_REPLICATION_DIR`; reject `BADIZO_SYNC_ENROLLMENT_CONFIG` at the same time. Use a distinct directory from legacy event-sync configuration. Do not place MySQL credentials in this directory or uploaded backups.

The separate OS service runs:

```text
node tools/backup/run-native-replica.cjs --config ABSOLUTE_PRIVATE_CONFIG_PATH
```

The private JSON configuration supplies `schemaVersion:1`, `shopId`, `channel`, `database`, source/replica UUIDs, baseline SHA-256 and verified-restore assertion, `applierUser`/`applierHost`, source/cloud activation IDs and generations, **actual internal** source/cloud database ports, local binding path, local/cloud loopback readiness URLs, control directory, fixed `sourceMysql` and `cloudMysql` loopback credentials, `minimumLogRetentionDays`, and reviewed tunnel/exclusive-applier assertions. The cloud MySQL connection port may be a forwarded port; `cloudDatabasePort` is the actual port in the cloud authority binding.

Provision local-only filesystem ACLs for the service identities. The web process may operate schedule/pause/request files and read sanitized status; private controller credentials remain outside its configuration directory. A stale agent lock is not automatically deleted: verify the old process has stopped before operator recovery.

No installer file containing real passwords is committed. This document does not authorize activation.

## Validation and remaining acceptance

The isolated drill `node tools/backup/native-replica-drill.cjs --isolated` creates **new test-only** MySQL data directories under workspace outputs and binds only ports 34081/34082 on loopback. It uses synthetic invoices/ledgers/stock, 32 MB InnoDB buffers and below-normal process priority. It stops only processes it owns and retains the fixture report; it never accepts a production configuration.

The drill verified exact-target exclusion of later sales; consistent multi-table application; source writes while cloud was blocked; pause without false completion; persisted target recovery across MySQL and agent restart; and authority invalidation. Runtime-only read-only/filter settings were correctly rejected after restart, then persisted startup configuration was tested. The hardened channel uses the scoped locked applier and row-only events.

This is not yet a live cloud acceptance test. Before activation, validate the real tunnel, account privileges, full baseline, authentication/recovery while standby is read-only, application release compatibility, backups/restore, a controlled cloud promotion and return-to-local, and measured checkout latency during a realistic backlog. Keep native mode disabled until these checks pass.

MySQL references: [START REPLICA / UNTIL](https://dev.mysql.com/doc/refman/8.0/en/start-replica.html), [channel filters](https://dev.mysql.com/doc/refman/8.0/en/replication-rules-channel-based-filters.html), [replication privilege checks](https://dev.mysql.com/doc/refman/8.0/en/replication-privilege-checks.html).
