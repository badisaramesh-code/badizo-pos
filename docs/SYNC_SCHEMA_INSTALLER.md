# Explicit sync schema installation

This tool installs optional synchronization infrastructure only. It never runs on normal POS startup, changes existing business tables, activates billing, creates an enrollment row, or enables capture. It is not a complete Windows POS upgrade package.

Run on the database host with a protected JSON configuration containing `host`, `user`, `password`, and `database`. Supported MySQL series: 8.0. Use the exact shop-tested version for rollout. Keep credentials out of command arguments and source control. The installation account needs schema read, CREATE, CREATE TEMPORARY TABLES, and migration-ledger SELECT/INSERT/UPDATE permissions; do not give these installer permissions to the everyday POS account merely to run this tool.

From the repository root:

```powershell
node tools/fleet/install-sync-schema.cjs C:\Protected\shop-db.json --plan badizo_pos
node tools/fleet/install-sync-schema.cjs C:\Protected\shop-db.json --apply badizo_pos
```

Before applying at a shop, verify a recoverable backup and the actual installed release/schema. The plan validates every existing sync table against the pinned release definitions. It uses temporary tables to ask MySQL to normalize expected DDL; plan mode makes no persistent database changes.

The installer validates `database/migrations/sync-release.json` checksums, takes a database-specific advisory lock and records each table separately in `sync_schema_migrations`. DDL is not assumed to roll back. If a process stops between table creation and journal completion, rerun the same release: the existing definition is verified before that journal entry is completed. Missing previously verified tables, changed release checksums, unrecognized history and schema mismatches require inspection. Do not delete history or change checksums to bypass these checks.

Existing populated sync tables are never truncated, and enrollment is never reset. A schema with different identity collations is intentionally rejected; changing identity comparison rules requires a separately reviewed migration. Additive tables may remain in place if an unused release is rolled back. Once new sales or sync activity exist, reverting to an older database is not a safe rollback.

Validation: `tools/fleet/validate-sync-installer.cjs` runs only against names matching `badizo_recovery_*`. It exercises plan, wrong-database rejection, injected interruption, repeated execution, and preservation of business counts/enrollment. It is a synthetic isolation drill, not authorization to run it on a shop database.
