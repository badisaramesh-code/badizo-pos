# Incremental transfer implementation boundary

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
