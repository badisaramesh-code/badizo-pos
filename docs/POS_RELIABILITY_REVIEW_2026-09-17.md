# POS reliability review — 17 September 2026

This review improves checkout reliability and preserves the existing pending POS changes. It is a tested source release for review, not a certification that the entire application is bug-free. The live backend was not restarted and the final build was not deployed during this review.

## Fixes

- Price changes between scanning and checkout return a structured PRICE_CHANGED conflict. Known validation failures do not trigger unnecessary invoice recovery requests.
- Recovery uses the unique checkout request ID, with an eight-second lookup and no automatic GET retries. Preview invoice numbers are not used to identify a saved sale.
- Automatic POST retries require a checkout request ID. Saved retries retain free items, reject changed cart contents/totals and cancelled invoices, and compare quantities at the database's two-decimal precision.
- Cash received and change are calculated by the backend. A client-supplied change value can no longer corrupt stored cash change. Mixed tender is derived from the supplied payment amounts.
- Mixed payments reject negative/non-finite amounts and digital overpayment. Reproduction before the fix: a Rs.100 bill with cash 10, UPI 200 and card 200 produced recorded payment rows totalling Rs.400. No live bill was created for this test.
- Zero quantity no longer silently becomes one sold item.
- Express 4 route handlers forward rejected promises to a JSON error response. Connection-acquisition and rollback failures are contained rather than leaving an unhandled request. Database errors are not automatically treated as permission to repeat a sale.
- Existing report approval, counter-label, screen/print styling and installer changes were reviewed and retained. Offline packaging now honors explicit installer and frontend-build paths without requiring unused default paths.
- Backend compatible dependency updates clear the backend npm audit findings. Frontend compatible updates include Axios; SheetJS uses the official 0.20.3 distribution. PDF imports disable dynamic evaluation using the vendor's documented workaround.
- Frontend npm configuration omits optional native packages. Required browser PDF helpers are explicit dependencies, so the build does not depend on optional Node canvas binaries.
- Temporary diagnostics and Python caches are excluded from new Git additions. Environment files, backups, built installers and generated frontend bundles are not newly staged.

## Validation

- Backend: 28 passing tests, including HTTP checkout tests using an isolated database double; no test sales were written to the shop database.
- Frontend: 23 passing tests across eight suites, including checkout retries, PDF loader safety, spreadsheet barcode/quantity round trips and inward invoice parsing.
- 97 JavaScript/JSX source files parsed successfully; four changed PowerShell scripts parsed without syntax errors. Installers were not run on the live server.
- Final production build compiled successfully in CI mode, separately from the currently served frontend. Main bundle: main.4b8e8d77.js. The build still reports a bundle-size recommendation (about 975 kB gzip).
- Backend npm audit: 0 reported vulnerabilities after compatible updates.
- Frontend npm audit with the committed optional-dependency policy: 29 remaining findings (15 high, 5 moderate, 9 low). Optional native dependencies are omitted; this count does not represent an optional-inclusive installation.

## Read-only live checks

- Database responded successfully. No duplicate non-null checkout request IDs were found.
- Paid invoices in the preceding 30 days: no invoice/payment-total mismatches found.
- Invoice items: no non-positive quantities, negative rates or returned quantities greater than sold quantities found in the query.
- 16 paid cash invoices in the preceding 30 days have received/total/change discrepancies. Historical records were not changed. Reconciliation against original receipts is still required; the new server-side settlement prevents client change values from causing the same class of discrepancy in future bills.
- A configured non-default JWT secret was present; its value was not displayed or committed.
- The 17 September 09:00 local backup passed gzip decompression and contained a completed SQL dump marker. This checks archive integrity, not a full restore rehearsal.

## Remaining work and limits

- Migrate the legacy react-scripts toolchain and PDF.js to maintained compatible releases, with full PDF/import/print verification. The PDF mitigation protects the current import call but does not remove the package-level audit finding. No forced npm upgrade or toolchain replacement was performed.
- Reconcile the 16 historical cash-change discrepancies manually before any accounting data correction.
- The browser inspection runtime failed to initialize because of the Windows sandbox helper. Visual usability and physical printers were not re-tested in this release. The user confirmed successful save and printing earlier in the task, before this broader review.
- A database restore drill, a multi-counter load test, all printer hardware combinations and every accounting/business-rule edge case were not covered. Tests using a database double do not prove MySQL locking behavior under concurrent traffic.
- Release the reviewed backend and final frontend together in a controlled restart window, verify database readiness and perform a real operator-confirmed cash/mixed-payment and print check. Refresh client screens after protecting any open drafts.

## Vendor references

- [Mozilla PDF.js advisory and isEvalSupported workaround](https://github.com/mozilla/pdf.js/security/advisories/GHSA-wgrm-67xf-hhpq)
- [SheetJS official distribution and installation](https://docs.sheetjs.com/docs/getting-started/installation/nodejs/)
