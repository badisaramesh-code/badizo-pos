# Sync availability checks — 7 November 2026

## Completed

The enrolled sync runtime previously used the same connection pool as checkout.
The worker holds a connection while transferring; pull holds another and the
receiver needs another connection. Small pool limits can therefore block sync
and consume the slots needed for billing. Server composition now creates a
separate pool with four connections and a maximum queue of eight. Every sync
connection sets InnoDB and metadata lock waits to two seconds. Failed setup
destroys the connection; completed/failed operations release it. Startup
failure and server shutdown close the separate pool.

Twenty isolated tests passed, covering daily 20:30 IST defaults and schedule
persistence, authenticated manual requests, rejected unauthorized/incorrect
peer requests, receiver rollback and duplicate detection, pool cleanup, and a
2,160-event backlog in batches of at most ten. The backlog test injected 22
lost acknowledgments after simulated receiver commits; all events were
eventually acknowledged and every batch released its lock and connection.

Command (with installed backend dependencies available through NODE_PATH):

```
node --test backend/tests/syncDatabasePool.test.js backend/tests/syncOutboxFaults.test.js backend/tests/syncTransport.test.js backend/tests/syncPull.test.js backend/tests/syncEventProtocol.test.js backend/tests/cloudSyncSettings.test.js
```

The initial restricted run blocked localhost HTTP requests and temporary-file
replacement. The rerun with permission for those isolated operations passed
20/20. None of these tests connected to a business database.

## Not established / deployment blockers

* Database adapters in the backlog test are simulated. This is fault/retry
  coverage, not a measurement of production MySQL throughput or latency.
* The installed mysql executable is under `MySQL Server 9.7`. No confirmed
  MySQL 8.0 fixture connection configuration was available. The required 8.0
  enrollment check was not bypassed. Real transactional queue/rollback and
  bidirectional HTTPS drills remain pending against disposable MySQL 8.0
  databases. Existing fleet drills restrict database names to
  `badizo_recovery_*`.
* An already active local installation can now start with sync paused after a
  sync initialization failure if its billing authority and database identity
  are verified. It records a durable capture-gap marker before serving sales.
  Rebuilding a verified baseline is required before normal switching resumes.
  A failed database or uncertain billing authority still requires recovery.
* Separate connection pools reserve checkout capacity but still share CPU,
  disk, row locks, and MySQL server connection limits. Sync capture also adds
  transactional writes to sales. Zero performance impact is not established.
* Real printers/scanners, live network loss, Windows crash recovery, and the
  shop's MySQL 8.0.46 behavior need acceptance checks with shop equipment.

Daily sync limits the recoverable cloud state to the last completed transfer;
sales after that point cannot be retrieved from a lost local disk unless
another surviving backup contains them.

## Combined recovery regression review

The full backend suite passed 218/218 tests with isolated fixtures and loopback
HTTP. After adding guarded checkout identity coverage, the affected billing and
recovery HTTP suites passed 17/17. Frontend regression passed 45 tests in 14
suites; the final checkout journal suite passed 8/8 including storage failures.
These counts overlap and must not be added together as distinct coverage.

Two additional fixes preserve local operation: recovery completion wraps the
original async handlers before generic error handling, including Express Router
composition; confirmed checkout validation rejections release the pending bill
journal so the cashier can correct the bill. Unknown save outcomes retain the
journal and original request identity.

The browser journal is specific to a browser origin. An unresolved local bill
does not automatically become a pending cloud bill when opening another host.
Cross-host uncertain checkout recovery needs explicit acceptance validation.
Printer, barcode and printable invoice components match main, but physical
printing/scanning after a server switch remains unverified.

Release decision: do not enable enrollment on live shop billing until the
MySQL 8.0 recovery/load and shop counter rehearsals succeed.
Existing authentication and isolation tests are not a full penetration test.

The recovery-enabled production frontend build compiled successfully (exit 0)
with all four recovery flags enabled and source maps disabled. Warnings were
bundle size and stale browserslist data. The redundant default-flags build was
cancelled to free memory and is not counted as passed. Changes and QA evidence
remain in the isolated recovery worktree; no live installation was updated.


The availability update passed the full 229-test backend run and the 55-test
frontend run. New checks cover stopping a switch at a safe boundary, inspecting
a lost activation reply after restart, preserving a local sync gap, and two
supervisors competing to replace a dead process. On a network partition the
owner still has to stop all counters on the other installation before choosing
emergency billing.
