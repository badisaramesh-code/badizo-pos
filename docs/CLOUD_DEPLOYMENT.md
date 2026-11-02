# Hyper Fresh Mart cloud deployment

This deployment belongs to HFM001 (Hyper Fresh Mart), not Hyper Fresh Mart 2.0. Source and frontend are installed in immutable `/opt/badizo/releases/<full-commit>` folders; `/opt/badizo/current` selects the deployed version. Secrets live outside source control in `/etc/badizo/pos.env`.

Cloud deployments set `BADIZO_NODE_ROLE=cloud-standby` initially. They bind only to `127.0.0.1:5000`, disable the compatibility redirect, disable Windows daily-backup recovery/sales-alert schedules, require a strong independent JWT secret, disable legacy default-password fallback, and skip database schema initialization on normal restarts. A separate setup step runs schema initialization against a tested database copy first. Cloud initialization does not create or reactivate the default local accounts. Existing local installations keep their defaults when no cloud role is configured.

Cloud frontend builds use `REACT_APP_API_BASE_URL=/api` and `REACT_APP_BADIZO_CLOUD_BUILD=true` so UI and API use the same private origin and display the server's actual standby/active status. Existing local frontend builds retain their original API discovery behavior.

Standby blocks API mutations other than login/logout. It is safe for login and read-only inspection but does not accept bills. Cloud-active mode uses `CL/` invoice numbers; local numbering remains `BZ/`. Activation is a controlled operator procedure, not automatic counter fallback: stop local billing, stop incoming sync, verify the last transfer and invoice numbering, then change the cloud service role and restart. Returning to local requires transferring and verifying cloud changes before local writes resume.

The `badizo-pos` systemd service uses a dedicated OS account, protected environment file, automatic restart, and loopback-only listening. `/api/ready` verifies database connectivity and reports HFM001 and the deployed source commit. `/api/health` remains a basic process liveness check.

Private access for the development laptop is through an SSH tunnel to the existing Lightsail instance. The downloaded administrator SSH key is for the owner/development laptop only; do not copy it to shop counters. Counter VPN/device credentials and physical receipt/barcode printing still require a separate onboarding and acceptance test.

Daily incremental syncing and Update Cloud Now are not activated by starting this service. They still need an authenticated connection/checkpoint setup on the actual HFM001 shop server. The development database must never be used as the source. Daily Google Drive backups and current local printers/startup tasks remain untouched.

Test bills are created only in `badizo_cloud_validation`, an isolated database with separate credentials. The production cloud copy must retain its original invoice count during installation tests. Schema migration has a protected pre-installation SQL backup under `/var/lib/badizo/pre-install` for rollback. No deployment scripts or commands should expose SQL passwords, application passwords, or JWT secrets in process arguments or logs.
