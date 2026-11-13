# Recovery implementation acceptance — 13 November 2026

The source changes are opt-in. They do not enable daily replication, replace a
production database, provision the cloud service or change scheduled backup tasks.

## Completed validation

- Combined backend suite: 358 passed, one intentionally skipped, zero failures.
- Combined UI suite: 152 passed across 30 suites.
- Production UI build passed with checkout recovery enabled.
- Delta-plan tests: six passed. SQL importer Python tests: three passed.
- Vendor MySQL two-instance daily-replication drill passed: exact target, continued
  source writes, transaction consistency, pause/restart and authority invalidation.
  Evidence: `outputs/native-replica-drill-356e936c-6b2d-46a3-9afa-21820db12217/report.json`.
- Actual shop backup restored into a new private MySQL instance: 81,847 invoices,
  547,048 invoice items and 83,050 payments. Candidate preparation and fresh invoice
  namespaces passed. Evidence:
  `outputs/restore-roundtrip-c8701b01-1632-4827-885f-b940b180abe3/report.json`.

The real restore drill covers import and candidate preparation, not the complete
production upload, service activation, owner login and failback workflow.

## Production acceptance still required

1. Provision protected configurations, scoped empty restore slots and the external
   supervisor. Share the active binding with both backup tasks and retry tasks.
2. Verify the real tunnel and restricted native controller/applier accounts, exact
   baseline coordinates and local/cloud authority identities.
3. Exercise cloud owner login while standby is read-only, upload activation,
   cloud billing and a full cloud-to-local backup return.
4. Test interrupted activation and the documented operator recovery procedure.
   Process-crash testing does not prove Windows power-loss metadata durability.
5. Measure billing latency under realistic daily backlog before enabling sync.

Only one server may accept billing writes. A restore or promotion invalidates the
native baseline; Resume cannot replace explicit rebaseline verification. Repeating
an old upload after recovery activation is conservatively blocked, including after
Pause. Unsigned SQL requires trusted-owner attestation and isolated staging.

Bound backup retries preserve historical/unattributed files and hold retention
pruning until lineage-aware cleanup is implemented. Monitor disk usage.

The compact billing/audit UI rollout is a separate subset deployment; it does not
activate this recovery implementation.
