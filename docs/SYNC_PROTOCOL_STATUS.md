# Incremental transfer implementation boundary

## Current operational status

Development only; no production sync or automatic switching is enabled. Real isolated MySQL drills now cover checkout capture and ordinary checkout/cancellation/full and partial return application, identity mapping, duplicate delivery, dependency retry, altered-event rejection and stock restoration. Historical sections below record earlier milestones; their outstanding items may have since been partially implemented. The remaining deployment blockers are complete domain coverage (including batch, loyalty, promotion, purchase and master-data writes), snapshot baselines, authenticated enrollment, authority controls, scheduler integration, owner-button execution, restore activation/rollback and end-to-end deployment validation. These are development tasks, not all dependent on a shop visit.

The daily/hourly worker and manual-update API/UI have since been composed and validated as described below. Production enrollment, authority checks and full-domain activation remain blocked; the default server still reports not configured.

`syncEventProtocol` defines a bounded, versioned event envelope, deterministic content hash, explicit shop/origin validation and an injectable receiver. A received event's inbox receipt and all handler business writes share one transaction. Duplicate events with identical content are acknowledged without running the handler again; reusing an identity with different content is rejected. Unsupported event types are rejected before database access. If a handler fails, its receipt and writes roll back together.

The optional inbox SQL migration is not installed or run at startup. The receiver is not mounted as an HTTP endpoint. There are no live business handlers. The tests use a transactional adapter to check sequencing and rollback contracts; they do not prove MySQL locking, replication or crash durability.

Before activation: implement stable cross-installation business identities, transactional outgoing capture for every supported write path, ordered/dependent-event processing, authenticated encrypted transport, persistent acknowledgment/retry state, domain handlers, MySQL integration/fault tests and recovery reconciliation. Authentication must derive the peer identity from enrolled credentials. Body-supplied origin fields alone are not authentication. Handlers must use only the transaction connection and must not issue external side effects or auto-committing DDL.

This work does not change the local-first policy or install sync on either live server. It is an unconnected infrastructure component, not a completed synchronization feature.

## Transactional outgoing queue

`syncOutbox.enqueue` writes an event using the caller's transaction connection; it never independently commits. The optional outbox migration is not installed at startup. `createOutboxSender` serializes flushes with a MySQL advisory lock, reads pending events in bounded batches, verifies their content hashes, and acknowledges each only after the receiver confirms its commit. Lost acknowledgments leave events pending for an idempotent retry. Failed events stop the current batch. Queue records are retained; no deletion/purge policy is enabled.

On 2026-11-02 `validate-sync-mysql.cjs` passed against two separate restored MySQL 8.0 validation databases. A rollback removed the outgoing event, a deliberately lost acknowledgment left the source event pending after receiver commit, and retry acknowledged it without duplicating the recipient business probe. This used synthetic validation transactions, not actual POS checkout integration. It verifies real InnoDB receipt/queue behavior but not WAN transport or arbitrary domain-event reconciliation.

Pending: capture in every relevant POS write transaction, business identity mapping and event handlers, authenticated transport, backoff/scheduling integration, prerequisites/dependency ordering and return-to-local reconciliation. Sequence allocation is not a global commit-order guarantee; dependent events require explicit application checks. No live daily synchronization is enabled by this module.

## HTTPS transport

`syncHttpTransport` now sends bounded JSON events over HTTPS with a dedicated credential, request timeout, no redirects, bounded acknowledgments and explicit committed-event checks. `syncReceiver` authenticates before parsing, uses a fixed configured receiver identity, and blocks incoming writes by default unless an injected authority check permits them. This router is deliberately not mounted in the production server; the authority check alone is not a complete fencing mechanism and must eventually share the database transaction/authority controls.

The real HTTPS/MySQL drill `validate-sync-https.cjs` passed using a separately trusted test certificate (certificate verification stayed enabled), two isolated recovery databases and synthetic business probes. Invalid credentials and cross-shop events were rejected. A lost acknowledgment retried without duplicate application. This establishes the transport/queue integration, not production billing integration or network-partition recovery.

Remaining transport deployment work includes credential enrollment/rotation, trusted production certificates, network configuration, operational limits and shared authority controls. Production business-event handlers, transactional capture and automatic scheduling remain unconnected. The live-shop inspection is deferred at the owner's request; independent development can continue.

## Actual checkout integration

`billing.js` now calls opt-in `checkoutSyncCapture` immediately before committing checkout. Without `BADIZO_SYNC_CHECKOUT_CAPTURE=true`, it performs no sync SQL. When explicitly enabled it requires the optional outbox schema, `BADIZO_SHOP_ID`, `BADIZO_INSTALLATION_ID`, and `BADIZO_SYNC_PEER_INSTALLATION_ID`. Invoice, item, payment, batch-allocation and loyalty rows are serialized on the existing checkout transaction connection, preserving decimal/date strings. Capture failure rolls back checkout rather than silently losing its outgoing record.

Real validation POS drills passed on 2026-11-02: login and barcode lookup, successful checkout with one captured event, replayed checkout with no duplicate invoice/event, and injected queue-write rejection with no invoice committed and stock unchanged. The failure constraint was removed afterward. Production capture remains disabled. The included validation CLIs require the explicitly named `badizo_cloud_validation` database and are run from an isolated backend release directory with the protected validation environment.

This event records checkout evidence. It does not yet implement target-side invoice/stock reconciliation, source-ID mapping, complete customer/batch/master-data replication, returns/voids/purchases/other changes, or automatic scheduling. Do not treat capturing checkout alone as a complete backup or enable it on the shop before the entire write-path integration and startup preflight are validated.

## Cancellation and return capture

The same opt-in capture now also runs before committing `/invoice/void` and `/return`. Events record the invoice state, related checkout records and return headers/lines, with the triggering return number explicitly identified. A cancellation must contain CANCELLED state, and a return must contain its referenced return record; incomplete captures fail the caller's transaction. Existing default installations do not query sync tables on these routes.

The real `validate-invoice-lifecycle.cjs` drill passed against the isolated validation POS: actual checkout followed by a return, another checkout followed by cancellation, rejected repeat actions, exactly four source events and restored stock quantity. This is source capture, not target application. Purchases, master-data changes, account adjustments, payroll, other writes and cloud/local reconciliation still need integration. None of these capture flags are enabled on the shop or production cloud.

## Receiving-side product fields

The merge allowlist now uses the real POS schema fields `product_name` and `sale_price`; the earlier illustrative names `name` and `selling_price` are not accepted. Regenerate old validation review fixtures using the actual field names. No production reviews were deployed under the illustrative contract.

`productSyncHandler.applyProductFields` locks a product by barcode, validates allowed fields and exact money format, checks every expected prior value, and applies the selected values using the receiver transaction. Missing products, unsupported fields, duplicate field assignments or stale values fail before update. Stock is not overwritten. The handler is not mounted/enabled for production; it must be connected to authenticated, authorized resolution events and authority controls before deployment.

The real MySQL `validate-product-apply.cjs` drill passed in an isolated restored database: product price changed, duplicate event applied once, stale edit rejected with its receipt rolled back, stock unchanged and original price restored through a second event. This does not implement invoice/stock reconciliation, owner-decision delivery, master-data capture or general multi-table merging.

## Ordinary checkout application

`checkoutSyncHandler.applyCheckout` applies ordinary captured checkout records in the receiver transaction. It verifies decimal totals/payment totals, source/target column compatibility, invoice references and existing products; inserts invoice/items/payments with target-generated numeric IDs; and deducts stock once. Product locks are acquired in barcode order. It rejects invoice collisions, missing products, incompatible schema and unsupported cases rather than overwriting existing records. The receiver receipt commits with business changes.

This initial profile deliberately rejects batch allocations (including positive batch inventory on the target), exchanges, free-item/active product promotions, loyalty effects and non-PAID invoices. Capture/application flags are not enabled in production. Cross-installation numeric ID mappings for later returns, lifecycle replay, dependent-event ordering, snapshot baselines and complete business reconciliation are still required before operational use.

A real captured bill from the isolated POS was successfully applied into a separate restored database on 2026-11-02. Invoice creation and stock deduction succeeded, duplicate delivery was acknowledged without reapplication, and a separate event colliding with the same invoice rolled back its receipt. The ordinary-bill test passed again after adding target batch checks. This is a narrow application profile, not a full shop synchronization rollout.

## Ordinary invoice lifecycle application and identity mapping

Checkout application now requires `optional-sync-invoice-map.sql`, installed explicitly alongside the inbox migration. It stores the originating checkout payload and maps source invoice-line IDs to receiver IDs in the same transaction as the invoice and receipt. Existing previously imported validation bills without mappings are not silently adopted; they require a new clean baseline or explicit reconciliation.

`invoiceCancellationSyncHandler` verifies the originating checkout, unchanged invoice lines, paid target state and no return history before restoring stock and recording cancellation. `invoiceReturnSyncHandler` maps source line IDs to target IDs, requires prior returns to arrive first, verifies sold/returned quantities and refund/tax totals, records return headers/lines and updates stock and invoice state. Unsupported tax rounding remains pending for reconciliation. Both handlers use only the receiver transaction; neither invokes printing, notifications or outgoing capture. They remain unmounted in production.

Real isolated POS-to-MySQL drills passed on 2026-11-02 for cancellation, full return and two consecutive partial returns. Tests verified early lifecycle delivery rejects without a receipt, replay succeeds after prerequisites, altered payloads roll back, duplicate delivery has no repeated stock effect, reissued actions under a new event ID are rejected, and returns reference mapped receiver item IDs. Production invoice count remained 72,656 before the drills.

The partial-return drill exposed a pre-existing return-number collision: two returns in the same second generated the same `SR-<timestamp>`. Return numbers now preserve that readable prefix and append a UUID (50 characters total, within the existing VARCHAR(60)). The real same-second return test passed after this fix in the isolated backend. It has not been deployed to the shop or production cloud.

## Durable schedule and manual update

`cloudSyncRuntime` composes saved schedule preferences, the transactional outbox sender and `cloudSyncWorker`. The optional `sync_worker_state` migration must be installed explicitly; there is no startup DDL. The worker persists daily/hourly due times, manual requests, successful queue-drain time and exponential retry backoff (30 seconds up to 30 minutes). A MySQL advisory lock prevents overlapping workers for the same shop/installation. Each tick sends at most ten events by default and continues a backlog on subsequent ticks. A success timestamp means the supported outgoing queue drained, not that all business tables were reconciled.

Manual requests can run while the automatic schedule is paused. Repeated requests are coalesced; a generation counter retains requests submitted during an active transfer. Pausing automatic sync pauses automatic retries unless a manual request is pending. Restart preserves pending work and backoff. Transport failure retains outbox records and exposes a generic retry state; credentials and transport responses are not persisted in worker status. Permission is checked before each run and each event by the composition layer. This is an integration hook, not a substitute for transactional authority controls.

`POST /api/cloud-sync/run` requires an authenticated SERVER user and accepts no supplied connection configuration. It returns 202 after saving the request. Cloud nodes and unconfigured installations reject it. The local System → Cloud Sync page invokes it through **Update Cloud Now**, polls status and displays retry state. Pending requests and active runs disable repeated UI clicks. `mountRoutes(app, {cloudSyncRuntime})` supports explicit composition; default startup does not create or start a worker. A deployment must supply a trusted HTTPS sender and complete baseline/domain/enrollment/authority preflight, then start and stop the runtime with the application lifecycle. No environment flag bypasses these missing production requirements.

The isolated real-MySQL worker drill passed daily 20:30 IST and hourly timing, lost acknowledgment with exactly-once receipt application, persisted backoff after runtime restart, automatic pause, manual transfer while paused, simultaneous-worker exclusion, retaining a request made during a run, and blocking transfer after permission revocation. It uses synthetic business probes in isolated recovery databases. HTTP authorization tests cover unauthorized/counter/admin rejection, authenticated actor identity, arbitrary body rejection and unconfigured defaults. These checks do not establish complete shop synchronization or browser-level acceptance.
