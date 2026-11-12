# HFM001 daily delta transfer

Requested time: 08:30 Asia/Kolkata (03:00 UTC), every day. Preserve the independent daily, weekly and monthly Drive backups. The incremental POS worker covers selected workflows; its last-success timestamp is not an all-table backup checkpoint.

Read-only preflight on the shop MySQL server: binary logging ON, ROW format, FULL row images, retention 2,592,000 seconds. No production enrollment, upload, or replay was enabled by this check.

Before activation, establish that the standby snapshot has an exact matching source binary-log position or GTID set and source identity. Without proof, create one fresh consistent baseline with coordinates and verify an isolated restore. Never guess a position by backup time.

Archive subsequent committed transactions to private cloud storage in order, verify integrity and continuity, and persist the checkpoint only after durable confirmation. Record uploaded and applied checkpoints separately. Stop and alert on a gap, divergent standby, or wrong source. Use only one applier for an overlapping set of tables; do not replay both POS events and binary logs into the same standby. Keep the standby read-only during routine operation. Re-establish direction and baseline explicitly after emergency promotion.

Acceptance before scheduling: on an isolated clone compare a mixed insert/update/delete sequence across products, billing, Local/Non-Local ledgers, day sheets and Payment Diary; interrupt and resume without loss or duplication; verify recovery from the baseline plus archived changes. Simulate a missing segment and verify an alert instead of a success report. Measure checkout latency under concurrent billing. Only then activate the 08:30 schedule and verify the first cloud checkpoint.
