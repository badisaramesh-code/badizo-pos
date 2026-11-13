# Backup upload recovery for local and cloud

This is an **opt-in recovery workflow**, not an in-place SQL import. No route is
registered unless `BADIZO_RECOVERY_CONTROL_CONFIG` is installed and
`BADIZO_BACKUP_UPLOAD_ENABLED=true`. The UI also requires the existing recovery
control build flag. Installing the source files alone does not enable recovery.

## Owner flow

The SERVER account opens System, selects a `.sql` or `.sql.gz` backup, uploads it,
and confirms that the other server/counters cannot bill and that transactions
after this backup may be missing. The supervisor then:

1. Holds target billing and drains admitted writes.
2. Invalidates automatic replication and obtains the shared database recovery
   fence. A native replica is stopped before its read-only state changes.
3. Reserves a pre-provisioned empty, database-scoped recovery slot.
4. Verifies uploaded bytes/checksum, bounded decompression and a completed dump.
5. Restores with the reviewed scoped importer, prepares the supported candidate
   schema, matches the configured shop identity, and checks referential/data
   integrity. No users/passwords/settings are seeded by candidate migration.
6. Assigns a fresh, collision-resistant recovery invoice namespace and protects
   sequence high-water marks. Previous printed references are not edited.
7. Switches a protected runtime binding, restarts POS in validating mode, verifies
   readiness, and only then opens billing. Counters sign in again; old pending
   checkouts remain held for owner review rather than being replayed into the
   restored database.

The old database and uploaded evidence are retained. A second upload cannot
silently replace an active recovered database or an already-billing cloud.
Returning the final stopped-cloud export to local uses the same path. Dumps
whose original database is a prior `badizo_recovery_*` namespace are recognized
and redirected only into the new scoped candidate.

After an uploaded recovery has activated, merely pressing Pause Billing does
**not** permit another old backup to replace that node. Both the runtime lineage
marker and a separate protected activation-history record block replacement,
even if a later binding update omits the marker. A trusted reviewed re-baseline
or authority-handoff procedure must establish a new lineage; no generic UI
history-reset button is provided.

## Protected provisioning

The existing supervisor configuration needs `uploadRecoveryConfigPath`, pointing
to a separate installed configuration, for example on Linux:

```json
{
  "schemaVersion": 1,
  "shopId": "HFM001",
  "directory": "/var/lib/badizo/recovery/uploads",
  "databaseDataDirectory": "/var/lib/mysql",
  "maxUploadBytes": 536870912,
  "maxExpandedBytes": 4294967296,
  "maxSpoolBytes": 21474836480,
  "maxStoredUploads": 20,
  "expectedShop": {"gstNumber": "INSTALL_VERIFIED_SHOP_GST", "shopName": "INSTALL_VERIFIED_SHOP_NAME"},
  "slots": [{"restoreConfigPath": "/etc/badizo/recovery-slot-01.json"}],
  "pythonExecutable": "/usr/bin/python3",
  "candidateMigration": {
    "file": "/usr/bin/node",
    "args": ["/opt/badizo/current/backend/scripts/prepare-upload-candidate.js"]
  },
  "fenceConfigPath": "/etc/badizo/recovery-fence-private.json"
}
```

These are examples, not credentials or ready-to-use provisioning. Windows uses
installed absolute paths to Node, Python, the existing MySQL data directory and
the same reviewed backend script. The importer currently supports a loopback
MySQL 8.0 target on an explicitly pinned TCP port (1–65535). Runtime bindings record the
port explicitly. Slot credentials must be scoped to exactly one distinct empty
`badizo_recovery_*` database, without roles, global privileges or grant option.
The reviewed product timestamp trigger needs the separately protected trusted
installer adapter; arbitrary stored routines/events/views are refused.

The migration command receives one supervisor-generated restore-config path. It
must return `candidateSchemaVerified:true`, `candidateDataIntegrityVerified:true`,
the exact database and shop ID. These limited checks do **not** prove a complete
financial audit or cryptographic provenance of legacy SQL. Unsupported older
schemas fail instead of running a broad application initializer.

The native fence configuration holds a separate worker-only loopback MySQL
control account plus the pinned native configuration. The supervisor acquires
`badizo-native:<shopId>` on one MySQL session, checks the expected UUID/channel/
source/filter/read-only state, stops both replica threads, and retains the lock
through staging and activation. Only then can fixed private code turn off
`super_read_only`/`read_only` for recovery. There is no UI `RESET REPLICA` or
arbitrary SQL/command endpoint.

Native configuration also pins the locked, database-scoped replication applier
account, row-format requirement, exact database filters and reviewed grants. The
fence adapter refuses a broad applier, a second channel or changed privileges.
On a proven pre-commit failure it restores read-only flags. After durable proof
that the new binding has opened for billing, it never makes that writer read-only
or rolls it back because of a later status-write error. Unavailable or conflicting
commit proof holds the operation for inspection instead of guessing.

Without native replication, the private fence instead requires the matching
shop ID, pinned `serverUuid`, `nativeReplicationAbsentVerified:true` and its
loopback `mysql` connection. It verifies that there are no replication channels.
Both modes verify that the checked data volume is MySQL's actual data directory.

The POS process may write the upload spool and request queue, but should not have
access to privileged fence or trigger-installer credentials. Use local durable
storage with restricted OS permissions and atomic rename/hard-link support, not
a shared or Drive-synchronized folder. An exclusive upload lock, source and
expanded limits, retained-job count and total spool quota prevent unlimited
uploads; a separate MySQL-volume free-space check runs before import. Completed,
discarded and failed evidence is retained for reviewed maintenance, not silently
pruned.

## Trust and operational limits

An unsigned daily backup is accepted only after an authenticated SERVER explicitly
attests that it is the trusted shop backup and accepts the missing-data window.
Checksum verification detects corruption; it does not authenticate an arbitrary
SQL file. GST/name matching and a completion footer are not a signature. A
hostile owner-supplied SQL file can still consume candidate resources even with
scoped grants; resource-isolated MySQL staging/OS quotas are required where
untrusted files must be supported. Never give uploaded SQL root/FILE/global
privileges or permit it to import into the live database.

The other billing server being unreachable is not proof that it is fenced.
Physical counter routing and/or the installed authority controls must prevent
it from resuming writes. Native synchronization is not automatically resumed
after a restore: the source/target databases and baseline must be verified again.
An old local upload plus newer cloud sales cannot reconstruct missing local
transactions by itself.

All restore/import work runs in the separate recovery supervisor OS service,
outside the POS service process group. Job stages are durable. An interrupted
import is never automatically repeated into a partial target. A lost completion
write is finalized only when the exact recorded candidate binding is already
active; a database that may contain new sales is never automatically rolled back.
Failure retains both databases and leaves billing paused for inspection.

Before production enablement, run a complete real-MySQL local→cloud→local drill
with the actual unsigned daily backup, owner login, import privileges, approved
trigger, supported schema, data checks, invoice namespaces, old-checkout fencing,
native pause, interrupted-job handling and readiness. Unit/HTTP tests with mocked
databases do not substitute for that drill. No production provisioning or restore
is performed by the source tests.

### Isolated backup validation performed on 13 November 2026

The pre-update shop SQL backup (SHA256
`c5b289ed0d2f64d3244e929e8bb01fff62860002903e80540098b2e79f0da2e4`)
was imported into a new private MySQL 8.0.46 instance, never the shop database.
The scoped importer, reviewed trigger installation, schema/data checks and fresh
invoice namespace passed, including all 81,847 invoices. Evidence is retained in
`outputs/restore-roundtrip-c8701b01-1632-4827-885f-b940b180abe3/report.json`.
This verifies import and candidate preparation; it does not yet verify the full
production upload, service cutover, authentication and cloud-to-local return flow.

The durable file helpers flush file contents before atomic rename. Process crash
tests do not establish Windows power-loss durability of directory metadata.
Production cutover acceptance must include that limit and a tested operator
recovery procedure; do not advertise power-loss-proof automatic activation.

Standalone backup tasks must use the updated backup scripts and the same protected
`BADIZO_RUNTIME_BINDING` pointer as the POS service. Otherwise an older scheduled
script can continue backing up the original database after recovery activation.
Source changes do not update installed scheduled-task commands or environment.

### Scheduled backups after activation

Both scheduled backup scripts follow the protected active runtime binding, rather than the original database name in `.env`. The daily retry (`sync-pending`) path also loads that binding. A binding change during a dump or transfer prevents the job from advertising current-backup success.

When a runtime binding is configured, the rolling daily job accepts existing artifacts only when their private authority sidecar matches the active activation ID and database name. Missing, malformed, or older sidecars leave those files untouched. Compression of a matching SQL artifact records authority for its gzip output. Remote filenames alone do not establish authority, so retries can upload another copy of matching artifacts. Local and Drive retention pruning is held in this bound mode to preserve historical backups until lineage-aware remote retention is implemented; storage must therefore be monitored. Existing installations without a runtime binding keep their previous retention behavior.

### Fixed reviewed-trigger command

Provisioning can use `triggerInstallerCommand` in each private slot configuration instead of a privileged MySQL defaults file. Its absolute executable and fixed arguments invoke `backend/scripts/install-reviewed-recovery-trigger.js PRIVATE_CONFIG`; the importer appends only the validated candidate database name. The private installer configuration pins `schemaVersion:1`, loopback `host`, exact `port`, `serverUuid`, and an explicit `slots` allowlist. It supplies existing privileged credentials through `mysql` or an installer-only `adminEnvironmentFile`. The command can create only the reviewed product timestamp trigger, checks the actual instance and products table, and takes a dedicated advisory lock. It does not accept dump SQL or install arbitrary stored objects. No new global SUPER grant or change to `log_bin_trust_function_creators` is needed.

On Linux, use a fixed privileged launcher when the worker cannot read installer credentials. On Windows the installed LocalSystem supervisor can invoke the protected fixed command. A POS process also running as LocalSystem shares that OS trust boundary; separating the POS service identity from the privileged supervisor is further host hardening, rather than a guarantee provided by database-scoped importer credentials alone.

### Linux supervisor state permissions

A root recovery supervisor may set `BADIZO_RECOVERY_SHARED_STATE_CONFIG` to a
root-owned, non-group/world-writable JSON file containing the verified POS group
`gid` and absolute `bindingPath`, control `directory`, and `uploadDirectory`.
Only the exact binding, control heartbeat/operation, per-upload UUID `upload.json`,
and activation-history metadata are published as root-owned group-readable 0640.
Slot/fence credentials, generated restore configs and previous/rollback bindings
remain private 0600. Binding parent directories must remain root-owned and not
writable by the POS identity. The policy is inactive for non-root processes and
on Windows. This supports separate root supervisor and unprivileged POS services
without publishing privileged installer credentials.


### Native standby emergency action

The current native standby installation explicitly sets the protected supervisor
configuration `emergencyCloudRequiresUpload:true`. UI, control request validation
and the supervisor reject legacy direct emergency activation. That older path
only changed a billing flag and did not establish a native replication fence,
new invoice/session authority or durable promoted-writer proof. It must not be
used to promote a read-only native standby.

The configured owner fallback is System backup upload recovery with a trusted
Google Drive backup after all local counters are fenced. To retain data received
by daily replication after the last Drive backup, a supervised export of the
stopped cloud standby can supply the trusted upload file. There is currently no
owner UI for that export, and direct native promotion is not implemented. A real
upload, cutover and cloud-to-local return acceptance exercise remains required.

Both local and cloud owner screens use System → Billing recovery. Sign in with
the SERVER role. Activate cloud and Return to local open the recovery workflow
for the selected destination. Review conflicts requires separately configured
review services. Upload recovery replaces a database and does not merge sales.

For a separately installed public session gateway, set BADIZO_BACKEND_ROOT to
the deployed backend directory, and load the same BADIZO_SHOP_ID and
BADIZO_RUNTIME_BINDING as the POS service. Restart the gateway when the binding
switches. Include tools/public-pos/recovery-locations.nginx in the authenticated
public POS site. Configure its upload limit to match the backend. Keep cloud
password hashes outside Git in a protected file readable by the POS service.
BADIZO_CLOUD_LOGIN_FILE can specify the file explicitly.
