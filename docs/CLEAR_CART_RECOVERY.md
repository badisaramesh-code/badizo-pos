# Clear Cart checkout recovery

Prepared 12 November 2026; not activated while counters are running.

The Billing page has an explicit Clear Cart action. Ordinary drafts clear immediately. An unresolved checkout is reconciled with its original server before its persistent journal is released. If already saved, the invoice remains intact and its number is shown. If unsaved, a persistent abandoned request ID prevents delayed requests from saving that bill after clearing. Network, server and busy-lock failures retain the cart and recovery record.

Checkout and abandonment share a MySQL named lock on a SHA-256-derived request ID. An abandonment marker survives restarts. A late checkout returns CHECKOUT_ABANDONED, which releases its client recovery record. The button never submits a new sale and does not cancel or refund saved invoices.

Included frontend fixes omitted from main: direct selling-line total calculation, release after confirmed INVALID_BILL_TOTAL, and guarded price refresh/reconfirmation after PRICE_CHANGED.

The documented half-rupee regression is fixed. Tests cover mixed GST, fractional quantities, quantity-price discounts, stale rates, cash increase/decrease, insufficient cash, UPI reconfirmation, retry identity, saved bills, rollback, offline retention, and Clear Cart outcomes. This is not a guarantee for every possible monetary input or future error. Server total and payment validation remain authoritative.

Deployment requires counters paused and in-flight sales finished. Back up installed application and database, add abandoned_checkouts using checkoutAbandonment.ensureSchema, deploy backend config/service/billing and the frontend build, restart server, verify readiness and authentication, then reopen counters between bills. Frontend build must preserve CHECKOUT_RECOVERY and other deployment recovery flags.

Do not deploy the new client without the backend. Rollback must retain abandonment markers: deploying an older checkout handler that ignores them could permit delayed abandoned requests to save.


## Continue with the next customer

Continue with Next Customer first persists the active recovery record in a separate parked list and verifies that write before releasing the active journal. New customers use fresh checkout IDs. Parking does not resubmit, cancel or discard the old request. It works while the server is unavailable, although completing a new sale still requires a reachable billing server.

Finish / Recover Original submits only the parked original payload with its original checkout ID. The existing server idempotency checks return the original invoice if saved. The original record remains pending on network errors. Cancel Unsaved / Check Saved uses the serialized abandonment endpoint; a confirmed unsaved cancellation can then be replaced safely. A saved invoice is never silently cancelled.

Local parked records retain resolved status and invoice numbers for handover. Metadata from local cashier archives is reported on parking and retried every minute, including archives belonging to a previous logged-out cashier on that machine. Server/Admin handover review determines status from invoices and abandonment markers. Offline counters cannot report until connected; inspect their local pending counts too. This is status reconciliation, not an automatic detector for separate manually-created invoices with different request IDs.

Never advise cashiers to enter the same uncertain customer's bill as a fresh sale. Use Finish / Recover Original, or obtain confirmed unsaved cancellation before replacement. Two unrelated customers may legitimately have identical products and totals; do not automatically void invoices based on similarity.


## Simple Server/Admin Bill Help

In Billing, open Bill Help / Handover Review. Use Check Bill beside the counter, cashier, time and amount. Saved invoices offer Print Original Receipt. Unsaved bills offer Release Unsaved Bill, followed by Confirm Release. The server checks again under the same checkout lock before recording a persistent release. Saved or cancelled invoices are not silently removed or refunded.

Action History shows time, actor, action, result and invoice number where available. Checks and releases are inserted into checkout_recovery_events. Unsaved release and its audit entry commit together; audit failure rolls back release. Busy/failed attempts are recorded when the database is reachable. Checkout rollbacks also record error outcomes and report metadata for admin review. The table currently lists the latest 200 reported requests and up to 200 actions per bill.

Counters report active unresolved as well as parked records, including records retained under a previous cashier on that machine. A failed checkout triggers an immediate report attempt and reporting retries every minute. Offline records cannot appear centrally until their counter reconnects. A confirmed admin release is recognised by the counter instead of becoming another recovery dead-end.

Validation: 60 frontend tests across seven suites and 18 focused backend tests passed; isolated real-MySQL validation verifies review SQL, audit persistence, serialized checkout resolution and saved invoice retention. Production build main.895ee1b7.js compiled with the existing recovery flags. Prepared only, not deployed while counters are running.
