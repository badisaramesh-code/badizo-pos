# Owner recovery preparation and reconnection

This opt-in workflow prepares recovery copies on the **two separate hosts**, then uses the supervised baseline activation protocol. It does not depend on a shared filesystem. Ordinary installations do not mount its routes or run its services.

## Owner flow

On the local server's recovery screen, the owner chooses one of two separately confirmed actions:

1. **Prepare verified copies and reconnect** pauses both original servers and requires their final business data to match the prepared snapshot before either is replaced. It does not merge divergent older histories. Use normal **Sync and return to local** when the existing baseline remains valid and pending transactions can be exchanged normally.
2. **Prepare from cloud after local data loss** additionally requires confirmation that the original local source is unrecoverable. It retains any existing local database separately, copies the final paused cloud snapshot, and never claims that unsent local records were recovered or merged. A failed connection or mismatched snapshot never selects this mode automatically.

The local supervisor requests a final cloud export over authenticated HTTPS. The cloud supervisor pauses and drains its writes, verifies the shop's source enrollment, fingerprints its business records, streams a MySQL dump to a protected file, and checks the fingerprint again. It restores that artifact into an unused configured cloud recovery slot. The local supervisor downloads the artifact using a bounded streaming transfer, verifies its SHA-256 and size, then restores into an unused local recovery slot.

Each restored copy must have the same business fingerprint as the paused cloud source. Its old synchronization evidence is archived before new identities are installed disabled. Checkout retry proofs and historical partial-return state are preserved. After both copies confirm the same baseline, the existing activation coordinator installs their protected runtime bindings, verifies both new runtimes and their sync connection, then opens **local billing only**. Cloud remains standby. The original databases, SQL artifact and operation journals remain available for review.

The source hold is `validating` throughout export and preparation. POS writes and ordinary background synchronization cannot mutate that source during its final checkpoint. External programs that bypass the POS application still require installation-level controls; this workflow is not a global MySQL write lock for arbitrary privileged clients.

## Installer configuration

Each supervisor configuration needs an absolute `preparationConfigPath` and `baselinePlanPath`, alongside its existing binding, enrollment and start/stop configuration. The preparation JSON is protected server-side configuration, never sent by a browser:

```json
{
  "schemaVersion": 1,
  "shopId": "HFM001",
  "directory": "ABSOLUTE_PRIVATE_PREPARATION_DIRECTORY",
  "incomingToken": "64_HEX_RANDOM_CHARACTERS",
  "baselineIncomingToken": "DIFFERENT_64_HEX_RANDOM_CHARACTERS",
  "allowedModes": ["verified-copy", "lost-local-copy"],
  "maxBytes": 2147483648,
  "slots": [
    {"restoreConfigPath": "ABSOLUTE_PRIVATE_SLOT_1_CONFIG"},
    {"restoreConfigPath": "ABSOLUTE_PRIVATE_SLOT_2_CONFIG"}
  ]
}
```

`mode`, if supplied by an older configuration, is only a default. The owner action selects and durably records the mode for an incident. A pending operation cannot change modes midway.

The cloud configuration additionally supplies absolute `dumpExecutable` and `dumpDefaultsFile` paths. The defaults file contains private MySQL credentials for the source database. The command forces the runtime's loopback host, TCP port 3306 and database; it does not accept an endpoint from the browser. `--no-tablespaces` avoids requesting global PROCESS privileges. MySQL 8.0 and the existing reviewed source schema are required.

The local configuration additionally supplies:

```json
{
  "peer": {
    "url": "https://CLOUD_HOST/api/recovery-preparation",
    "token": "CLOUD_PREPARATION_INCOMING_TOKEN",
    "baselineToken": "CLOUD_BASELINE_INCOMING_TOKEN"
  }
}
```

The reverse proxy must preserve these authenticated recovery routes, including streamed `GET /api/recovery-preparation/:operationId/artifact`, while enforcing HTTPS. Recovery tokens are independent of old synchronization baselines so a restored server can reconnect safely. They grant recovery control and must be protected like service credentials.

Each slot references a private configuration compatible with `tools/fleet/restore-staged.py`: shop ID, loopback host, scoped MySQL user/password, database, and absolute `mysqlPath`. The database name must match `badizo_recovery_` followed by 8–32 lowercase letters or digits. The target must already exist and be empty, with the recovery user granted privileges **only on that exact database**. A reviewed product trigger also requires the existing protected `triggerInstallerDefaultsFile`. Optional `pythonExecutable` selects the Python executable used by the supervisor; install and verify it before enabling recovery.

Provision several empty slots during installation. Selection is recorded durably and each slot remains reserved after use or a failed import. No operation empties, drops or silently reuses a previous recovery database. When all slots are consumed, the owner sees an explicit capacity error; the installer must add another empty slot. This is an intentional capacity boundary, not permission to erase historical evidence.

## Interrupted work and limits

- Downloads use unique partial files and do not publish an accepted SQL artifact until byte count and checksum match. Partial downloads remain operation-owned evidence; a retry starts a fresh download.
- Export and restore child PIDs are recorded. If the previous process may still be running, the workflow waits for inspection/retry rather than issuing concurrent SQL. If an interrupted restore process is confirmed absent, its partial database is retained and the next empty configured slot is selected. Unknown or reused process identities fail closed.
- An interrupted archive is retained under its unique name; a fresh complete archive must be durable before synchronization rows are reset.
- The same incident resumes with the same operation ID. After a completed activation, the next incident receives a new ID and unused slots. A delayed finalization from an old incident cannot replace the current plan.
- If preparation fails before candidate installation, the explicit **Emergency local billing** action may cancel preparation and reopen the retained original local database. It remains subject to the owner's confirmation that cloud billing has stopped. Cancellation never enables cloud billing. If cloud cannot be reached, local recovery remains possible and peer cancellation is visibly recorded pending. The owner can retry that cancellation when internet returns without pausing local billing; it releases only the cloud standby hold. Another preparation must confirm cancellation before starting a fresh incident. Once candidate installation has begun, this shortcut is refused rather than guessing which database contains new sales.
- Existing backups from Google Drive still restore through the separate staged-backup route. A backup alone cannot recreate records absent from both the backup and cloud. A legacy unenrolled source is not automatically assigned to a shop by a file label.
- Unsupported source schema objects, missing source enrollment, altered artifacts, insufficient disk space, divergent recoverable original records, and exhausted recovery slots stop the operation without enabling the candidate for billing.

The per-artifact size limit defaults to 2 GiB and is bounded to 20 GiB. Preparation reserves a conservative multiple of the artifact limit/size as free disk headroom, and database storage must also be provisioned appropriately. Final Windows service identities, MySQL privileges, reverse proxy routing, protected directory ACLs, counters and printers must be validated at the shop before this opt-in workflow is enabled there.
