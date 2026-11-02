# Audited financial and stock corrections

These actions are available to the signed-in SERVER owner on an enrolled local server. They are blocked during handoff and use the existing recovery write lease. They do not change default, unenrolled local billing.

## One supplier payment entered on both servers

The owner selects an existing local payment and confirms, using the supplier receipt or bank statement, that both entries describe **one physical payment**. Equal amounts alone are not proof. The software requires matching purchase/supplier, date, payment method, reference, amount, before/after balances, and an unchanged local payment captured in one unacknowledged event. This narrowly covers a duplicate-entry overpayment conflict. Ordinary separate payments and general overpayment/refund corrections remain outside this action.

The local transaction records a mapping from the incoming payment to the selected existing payment, acknowledges and retains the original incoming event, writes the owner evidence to `sync_recovery_applications`, and queues `pos.recovery.supplier-payment-matched`. It never deletes a payment or changes the purchase balance. The receiving cloud validates its retained original payment and unchanged balance, maps the covered local event to its own payment, and acknowledges the covered event without adding money again. Both original events and their owner-confirmed relationship remain evidence. The peer resolution must be delivered before synchronization is complete.

## Reviewed stock differences

The owner may interpret a blocked ordinary `STOCK_AUDIT` as a verified independent physical difference, rather than overwriting local stock with an older count. The inspected local quantity is checked again under lock. The source difference is added once, preserving local movements. Negative/out-of-range results, malformed events, and batch inventory are rejected.

If the same product has pending local stock audits, the screen lists them and requires explicit confirmation of every difference. Their IDs are bound to the request. Supported two-sided reconciliation requires a common starting quantity, an uninterrupted chain of local audits, and no unreviewed local stock movement. `pos.recovery.stock-deltas-reviewed` carries the original source event, reviewed local events, exact expected cloud quantity, and owner evidence. Cloud applies the covered local differences only if its expected stock is unchanged. Every covered event gets a receipt so later delivery cannot apply it again. Concurrent or batch cases remain blocked rather than forcing convergence.

## Atomicity, retries and reports

Business changes, mappings, original-event receipts, retained event evidence, outgoing resolutions, and durable correction evidence commit in one MySQL transaction. A stable case decision prevents a retry from applying a different correction. Application failure rolls everything back. Enrolled case review uses connection-owned MySQL advisory locks; process death releases these locks, allowing a safe retry using durable receipts. The filesystem-only review fallback is not the enrolled execution path.

The case records the authenticated owner, selected local payment or inspected stock/audit IDs, note, revision, outcome, and whether peer delivery is required. The PDF includes these selections and the before/after/current comparison. A locally resolved case does not prove that its outgoing peer resolution has completed: synchronization status and handoff drain remain the completion checks.

`backend/tests/financialCorrectionExecution.test.js` covers duplicate payment identity, preserving both records, duplicate deliveries, stock rollback, stale reviews, two-sided audit convergence, changed peer stock, malformed data, batch refusal, and local-only authority. `tools/fleet/validate-financial-corrections.cjs` performs the corresponding owner-API/receiver/MySQL drill using random synthetic fixtures only in explicitly named isolated recovery databases.

These tools are not arbitrary journal editors, automatic refunds, debt write-offs, or a mechanism to discard genuine sales/payments. Old-backup reconstruction must preserve and interpret the correction evidence, or stop for review; replaying the raw overridden stock audit alone is insufficient.
