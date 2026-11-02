# Recovery review implementation status

Recovery review is opt-in. With no flags, production startup does not load the recovery store or mount its routes. It cannot transfer business records, alter billing authority or activate local/cloud billing.

To enable review in an isolated validation deployment, set `BADIZO_RECOVERY_REVIEW_ENABLED=true`, an explicit `BADIZO_SHOP_ID`, and an absolute private `BADIZO_RECOVERY_REVIEW_DIR`. Build the frontend with `REACT_APP_RECOVERY_REVIEW_ENABLED=true`. The System screen then loads persisted sessions from `/api/recovery-review`. Server-role users can review individual differences, confirm eligible bulk choices, reload stale sessions and download the complete JSON decision history. JSON export is not the requested PDF report, which remains pending. The UI does not fabricate plans: plans must be supplied by a trusted recovery planner, whose database integration remains outstanding.

Cloud standby's existing mutation guard still blocks decision POSTs; enabling review flags does not bypass it. Test review saving in an isolated local-role environment until a specifically authorized cloud review policy is implemented. No deployed server has these review flags enabled.

`recoveryMergePolicy.js` compares scalar fields against an explicit common baseline. Equal changes and one-sided changes are distinguishable from competing changes. Approved product-field conflicts can be selected in bulk. Stock, financial and unapproved product fields cannot use this bulk operation. Record identity must eventually come from verified cross-installation mappings, not independently assigned numeric row IDs.

`recoveryReviewStore.js` persists plans and decisions in shop-specific local directories. Numbered records are published exclusively using hard links after writing and syncing the complete file. Concurrent submissions to the same revision have one winner; the other must refresh. Review decisions accumulate, and a correction appends a new revision while preserving the earlier decision. Every read verifies the stored chain and reconstructs the decisions. A review remains unapplied and never grants permission to resume local billing.

## Storage limits

Use a protected local filesystem supporting hard links. Do not put this directory in Google Drive, a shared network folder or an unverified filesystem. Pending files left by interruption are ignored; no partially written pending file becomes a published decision. Filesystem support, abrupt power-loss durability and disk-full behavior still require target-machine fault tests. File hashes detect accidental modification; they are not signatures or protection against a privileged attacker rewriting history. External backups and an independently recorded head revision are needed to detect complete history rollback.

## Integration still required

- Production routing and owner-account mapping. The isolated `recoveryReview` router now uses the existing SERVER role, derives the actor from the signed login, checks shop identity, rejects client-supplied authors, and requires an expected revision. It is exercised through real HTTP tests but is not mounted in the running application. It has no plan-creation, transfer or activation endpoint. SERVER is the existing privilege role, not proof of a distinct business-owner identity.
- Trusted baseline/checkpoint capture and transaction identity mapping.
- Current-checkpoint verification at apply time; a review snapshot does not lock the billing databases.
- Transaction transfer, duplicate protection, financial reconciliation and restore executor.
- Conflict UI and a verified PDF export of persisted decisions.
- Recovery state machine and controlled final cutover.

Unit/integration tests cover field comparisons, forbidden bulk decisions, stale previews, persistence across store recreation, cumulative decisions, corrections, concurrent submissions, cross-shop creation rejection, path rejection and corrupted records. They do not establish end-to-end sync readiness. The live shop and cloud are unchanged by these modules.
