# Multi-shop rollout contract

Each shop is an independent installation of the same versioned POS product. Shop identity, credentials, database, state directory, backup destination and sync checkpoint must be isolated. A shop ID in an HTTP status response alone is not tenant isolation. Use separate application processes and database users/databases for each shop; provisioning shared hosting requires explicit capacity and isolation validation.

The management application lives in the separate badizo-management repository. Monitoring failure must never prevent local billing. Management currently receives status only; it cannot deploy releases or grant billing authority.

## Available preparation tools

`node tools/fleet/shop-config.cjs tools/fleet/shops.example.json` validates a fleet configuration and prints read-only deployment plans. Duplicate shop/installation identities, inline secrets, unsupported MySQL profiles and initially enabled transfers are rejected. This command does not provision servers.

`node tools/fleet/package-release.cjs FULL_COMMIT NEW_OUTPUT_DIRECTORY` packages committed source and a SHA-256 manifest. It excludes untracked development files and rejects tracked credential/data paths. The output is source only: build, dependency installation, migration rehearsal and validation remain mandatory. It does not deploy or certify a release. Use a new output directory for every invocation.

The legacy Windows package builder copies working directories; do not use it to distribute another shop's configured installation. The new source packager does not change that legacy script or any existing startup task.

## Required rollout gates

1. Inventory the actual shop server: running release, MySQL version, schema, backup jobs, printers and startup service. Do not infer these from the development laptop.
2. Preserve a verified backup and the running application's configuration/release. Restore into an isolated validation database.
3. Test migrations and billing, stock, returns, reprints and receipt formats on that copy. Prepare rollback before modifying the shop.
4. Enroll independent local/cloud monitoring identities. Unknown telemetry stays unknown.
5. Establish a consistent initial database seed and matching incremental checkpoint. A daily SQL dump alone does not prove a safe binlog checkpoint. Verify capture availability and retention on the real server before choosing the transfer implementation.
6. Scheduled/manual updates share one worker and durable lock/checkpoint. Authenticate shop identity at both ends; reject changes while cloud billing is active. A retry must not duplicate bills or stock movements.
7. Activate cloud billing only after fencing local writes; reconcile cloud transactions and verify them before returning authority to local. Network failure alone is insufficient evidence that local billing has stopped.
8. Test actual counter connectivity and printers before calling the shop emergency-ready.

## Current implementation boundary

HFM001 cloud POS is running in standby. Configuration validation and clean source packaging are implemented. Sync scheduling preferences exist but no transfer worker is connected. Fleet provisioning, management hosting/enrollment, shop rollout, reliable fencing/failback and physical printer acceptance remain incomplete. No preparation command changes the running local POS.
