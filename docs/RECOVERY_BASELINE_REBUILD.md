# Rebuilding a recovery baseline

These tools operate on separately provisioned recovery databases. They never overwrite the original local/cloud databases, change a live runtime binding, restart a POS service, or enable synchronization. A database name beginning `badizo_recovery_` is not proof of isolation: that database might already have been activated for billing. Apply requires both protected original runtime-binding paths and rejects either selected database if currently bound. The tools hold the same per-database advisory lock used by supervised restore activation.

## Reconcile retained event histories

`tools/fleet/rebuild-recovery-baseline.cjs PRIVATE_CONFIG --plan` reads both staged copies. `--apply` executes eligible missing business events through the actual transactional sync handlers. The config contains `schemaVersion: 1`, `shopId`, the original `baselineId`, `detachedConfirmation: "RECONCILE DETACHED COPIES ONLY"`, absolute `reportPath`, and two `sides`. Each side supplies its original `installationId`, `peerInstallationId`, detached `databaseName`, absolute `credentialsFile` and `originalRuntimeBinding`. Credentials contain `host`, `user`, `password`, `database` and must address the selected local MySQL 8.0 recovery database.

The executor unions source outboxes and transactionally retained received-event archives from both copies. Every envelope/hash/shop/origin is verified. An own source outbox is proof that the source transaction committed; an inbox receipt proves incoming application. Missing own events can now be recovered from the peer's retained archive. A receipt with no available original event is a hard provenance blocker. Different payloads for the same event ID, inconsistent source ordering and an archive without its receipt are rejected.

Source ordering is taken only from original own capture. Archive auto-increment numbers are arrival order, so a later duplicate backfill is not mistaken for original transaction chronology. Product, supplier-payment and stock resolutions run before their covered originals; their embedded original evidence is retained. An originating recovery resolution whose original local review was lost remains blocked rather than being incorrectly applied as a peer-directed decision.

Every applied event commits its business changes, receipt and received archive together. Retries therefore do not repeat a payment or stock movement after a lost reply. Dependency failures remain pending for another pass, then appear in the protected report. The original source queues are not acknowledged/reset. Prior reports are retained inside `previousRuns`.

`retained-events-reconciled` means all **known retained events** are accounted for. It does not prove that no edits occurred while capture was disabled or that a transaction lost on both nodes existed. Consequently `readyForEnrollment` remains false. General divergent-backup activation still needs an automated proof of capture continuity and complete business/stock convergence. The tool deliberately cannot infer missing purchases or reconstruct stock from invoice totals alone.

## Prepare the explicit copy-snapshot path

`tools/fleet/rebuild-copy-enrollment.cjs PRIVATE_CONFIG` prepares two detached candidates restored from the **same verified SQL snapshot**. This is a separate copy operation, not a merge of divergent histories.

The config contains `schemaVersion: 1`, `shopId`, `confirmation: "COPY VERIFIED SNAPSHOT; PRESERVE ORIGINAL DATABASES"`, absolute `reportPath`, and two sides with `databaseName`, `credentialsFile`, `originalRuntimeBinding` and `artifactDirectory`. Each artifact directory must contain the original `database.sql`, `manifest.json`, and successful `restore-result.json` for that candidate. Both SQL hashes must agree and the actual SQL bytes are rehashed. The optional sync installer must already have installed the supported table set.

File integrity is not shop identity. Before any candidate reset, both restored `sync_enrollment` records must identify the configured shop with valid original installation/peer identities and baseline. A caller-supplied manifest label cannot substitute for this proof. Wrong-shop or legacy unenrolled snapshots are refused; they require a separate trusted shop-identity verification/onboarding process. This tool does not manufacture enrollment from an unverified backup label.

Before reset, the preparer fingerprints every business table's complete schema and row multiset, including immutable checkout-request retry proofs. Any difference blocks copying. It archives all old mutable sync-table rows and their schema to protected hash-verified JSONL files **before resetting either candidate**. Original databases and SQL artifacts remain unchanged. Both candidates then receive new installation IDs, activation IDs and one common baseline, with `sync_enrollment.enabled=0`. A per-side durable journal makes an interrupted preparation resumable.

Existing partial-return invoices receive matching baseline maps on both candidates, preserving their **current** returned quantities and existing return history. They are not rewritten as paid invoices. Unsupported partial-return exchange/promotion/loyalty profiles stop preparation. Immutable `sync_checkout_requests` rows are preserved and fingerprinted, never cleared with queues.

`prepared-disabled` is a candidate preparation result. Its `readyForProtectedEnrollment` flag means identities/configuration can be prepared; it is **not permission to activate billing**. `requiresFinalSourceCheckpoint=true` and `originalHistoriesMerged=false` remain explicit. Before switching, the supervised owner workflow must verify the selected source is paused at the exported checkpoint, preserve any newer local/cloud history, write matching protected runtime/enrollment configuration, verify both candidate processes, and activate only the chosen writer. These tools do not yet supply that final owner-button integration.

## Validation

Unit tests cover receipt-only gaps, hash collisions, reverse recovery of own events, resolution ordering, archive arrival-order differences, lost acknowledgements, idempotent resume, original queue preservation, active-binding rejection, snapshot mismatch, tampered SQL, retained checkout retry proofs, and interruption between candidate commits.

`tools/fleet/rebuild-recovery-validation.cjs` is an actual MySQL replay drill. It accepts a private config with absolute `directory` and two database credential objects under `sides`. It refuses nonempty databases or names outside `badizo_recovery_rebuild...`, creates only synthetic data, and checks recovery of both a lost own event and a cloud event, repeat-run safety, unchanged pending source queue and missing-history blocking. Provision these databases separately; the harness never drops a database.
