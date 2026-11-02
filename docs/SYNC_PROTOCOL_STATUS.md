# Incremental transfer implementation boundary

`syncEventProtocol` defines a bounded, versioned event envelope, deterministic content hash, explicit shop/origin validation and an injectable receiver. A received event's inbox receipt and all handler business writes share one transaction. Duplicate events with identical content are acknowledged without running the handler again; reusing an identity with different content is rejected. Unsupported event types are rejected before database access. If a handler fails, its receipt and writes roll back together.

The optional inbox SQL migration is not installed or run at startup. The receiver is not mounted as an HTTP endpoint. There are no live business handlers. The tests use a transactional adapter to check sequencing and rollback contracts; they do not prove MySQL locking, replication or crash durability.

Before activation: implement stable cross-installation business identities, transactional outgoing capture for every supported write path, ordered/dependent-event processing, authenticated encrypted transport, persistent acknowledgment/retry state, domain handlers, MySQL integration/fault tests and recovery reconciliation. Authentication must derive the peer identity from enrolled credentials. Body-supplied origin fields alone are not authentication. Handlers must use only the transaction connection and must not issue external side effects or auto-committing DDL.

This work does not change the local-first policy or install sync on either live server. It is an unconnected infrastructure component, not a completed synchronization feature.
