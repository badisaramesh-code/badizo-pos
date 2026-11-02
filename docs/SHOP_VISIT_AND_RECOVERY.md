# Hyper Fresh Mart: shop visit and recovery plan

## Sync policy

Keep one billing writer per shop. Scheduled transfers run from the active local shop to cloud standby. Start with the requested daily 20:30 IST schedule; hourly is the recommended later setting for a smaller potential gap after an unexpected outage. Manual Update Cloud Now supplements the schedule before planned cloud use. Frequency never guarantees zero loss: the last verified transfer determines the recoverable point.

Cloud activation after a crash requires an operator to fence the local billing service and counter access. If the local source is unavailable, display the last verified cloud data time and explicitly record the potentially missing interval. Do not claim that cloud has sales made since that point.

Return to Local is a controlled workflow, not a background hourly merge. Pause cloud writes, capture its final checkpoint, transfer to a staged local database, verify, then switch local billing and leave cloud in standby. Keep both old databases and a recovery record until reconciliation is accepted. If the failed local database contains transactions absent from the original cloud seed, reconcile those transactions before replacement. An ordinary restore would lose them. Distinct CL/BZ bill numbers alone do not prevent row-ID, stock or accounting conflicts.

The development code includes authenticated incremental transfers, a durable worker, coordinated planned handoff and guarded emergency activation. These controls have been exercised on isolated databases; they have not been activated on the shop installation. There is no automatic failover or intended parallel billing. An unreachable server cannot be remotely proven stopped: the owner must stop its counters before emergency activation elsewhere.

## One planned shop visit

Bring the reviewed source tools and a private output folder. Use the shop's actual environment file, never the development environment:

```powershell
node tools/fleet/inspect-shop.cjs "C:\actual-pos\backend\.env" HFM001 "C:\private-output\hfm001-preflight.json"
```

Replace both example paths. Dependencies resolve from this package's backend node_modules; install the locked dependencies on the development laptop before packaging the tool. Do not upgrade dependencies on the running shop merely to run this inspection.

This command performs SHOW/SELECT only, reads schema names/engines but no bill/customer rows, never invokes POS database initialization and refuses to replace an existing report. The report contains operational metadata, not passwords. It does not enable binary logging, restart MySQL, install tasks or change POS startup.

Also record the actual POS install path, process/startup task, running release identity if available, verified backup destination, counter connectivity and printer models/ports. Confirm the source backup can be restored. Inspect logging retention, source disk capacity and replication privileges before designing seed/capture installation. A compatible version alone is insufficient.

## Deployment boundary

The inspection is read-only preparation. Incremental transfer and controlled return-to-local executors exist in development; do not confuse their implementation with production enrollment. Shop-specific startup/service commands, runtime bindings, credentials, initial matching baseline, backup locations and reporter enrollment still need verified installation. No live shop synchronization or management enrollment has been activated by the development tests.

For the current older-backup recovery boundaries, use RECOVERY_BASELINE_REBUILD.md. A detached replay report is not permission to activate two databases: missing event history or unverified convergence must remain blocked. For the Windows application package and its installation prerequisites, use WINDOWS_ENROLLED_UPGRADES.md. This procedure does not upgrade Windows or MySQL.
