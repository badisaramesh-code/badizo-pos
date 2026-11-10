# Hyper Fresh Mart (HFM001)

This folder records the private connection for this shop. Read IMPLEMENTED.txt for the installation record and network rollback. Evidence files cited there are on the installation PC. No POS service loads this folder. Do not reuse these identities or addresses as defaults for another shop. Give each shop its own ID, database, credentials, CA and peer keys; give every counter its own peer key.

## What can be restored

The two .public files identify the enrolled WireGuard peers. The PEM files contain only public certificates. Check the CA fingerprint in IMPLEMENTED.txt against a separately trusted record before installing trust. The templates are for reconstructing settings; they do not grant access. This folder does not contain a sales database, passwords, or a bootable server backup.

The shop WireGuard private key can be backed up encrypted to a recovery public key or passphrase kept independently of Git and of the shop PC. Never commit an actual tunnel .conf, private key, PFX, .env, database dump, or recovery password. When replacing lost hardware, revoke its peer and enroll a new identity if compromise is possible. Never run a restored identity and the original at the same time.

The CA signing key is non-exportable in the SERVER Windows user profile. Its public PEM cannot sign renewals. If the PC is lost, issue a new shop CA, distribute verified trust to the counters and sync service, reissue the server certificate, verify access, then retire the old CA. Cloud WireGuard and TLS private keys remain on Lightsail. If lost, generate new keys there, update the enrolled clients' peer settings through a trusted channel and reissue the leaf certificate. Do not publish cloud host secrets to Git. Rehearse recovery on separate machines.

## Emergency billing at Hyper Fresh Mart

The local server handles normal sales. Lightsail is the emergency standby. As of 10 November 2026 the shop server has private HTTPS access. Sales sync, counter enrollment and a full switch-and-return drill are pending. Cashiers should continue using their usual local POS.

### Prepare each designated emergency counter after closing

Record the counter label, Windows user, receipt printer and operator. Generate a unique VPN key on that counter and enroll its public key with a unique tunnel address. Route only the private cloud address through the tunnel. Install the verified public shop CA for the cashier account. Give the cloud shortcut a distinct name, “Hyper Fresh Mart – Emergency POS”, alongside the normal local shortcut. On the test system verify cashier identity, counter number, scanner input, receipt printing and an uncertain checkout retry. Record the result for each counter.

For an Electron counter running the private HTTPS fix in [POS PR #2](https://github.com/badisaramesh-code/badizo-pos/pull/2), use `config/emergency-counter.json.example` as the separate emergency launch profile. Set `BADIZO_CLIENT_CONFIG` only for that shortcut's process, using an absolute path to the installed profile. Confirm the local shortcut still opens the shop server. The emergency profile connects directly to the cloud and uses the Windows certificate trust store. Check sign-in and receipt printing from each enrolled Windows account before marking that counter ready.

### Owner checklist for a local server failure (after commissioning)

1. If local counters still work and only the internet or VPN has failed, continue local sales. Check sync status after connectivity returns.
2. If the local server has failed, stop billing on every local counter, including the server PC. Prevent it from accepting new sales when it restarts. Record the last known bill on each counter, including any payment taken without a confirmed receipt.
3. Check the last successful transfer on the standby and compare the latest invoices with counter records. Identify the interval that may be missing. Look up uncertain payments and bills before entering them again. If another counter may still be billing locally, keep the cloud in standby.
4. Once all local billing has stopped and the owner has reviewed the gap, use the tested emergency activation procedure. Open the emergency shortcut on enrolled counters. Verify the shop and counter shown before taking the first payment.
5. To return to local, stop new cloud bills, finish pending payments, transfer and reconcile emergency sales, stock and payment totals. Account for any local sales made after the last successful sync. Reopen local billing only after the figures match and the cloud is back in standby.

### Commissioning after closing

Test the merged release on an isolated restored backup, including simultaneous local checkouts with cloud disconnected. Verify sync coverage and counter peripherals. Then schedule the live baseline, enable sync and rehearse the switch and return. Record the last successful transfer time and expected recovery gap. Keep the independent Drive backups running.

Run Backup-ShopKey.ps1 interactively on the original server to make a passphrase-encrypted copy of its WireGuard private key. Choose a long, unique recovery passphrase and keep it in an owner-controlled password manager accessible without this PC. The script checks decryption before producing shop-server.private.gpg. Only that encrypted file should be committed after the check. On a replacement machine decrypt with GnuPG into an administrator-only directory outside Git, then verify the derived WireGuard public key matches shop-server.public before using it. This covers only the shop VPN identity.

### Lightsail staging check on 10 November 2026

Linux build 5655bb73c741ac9877a31a81d40f025c1f9daad7 was staged under /home/ubuntu/hfm-staging/5655bb73c741ac9877a31a81d40f025c1f9daad7. GitHub Actions artifact 13770406101 matched its published SHA-256 cbfd5beb60a1cbb030fd3259be25a4ad7ca7522f747ee34328672978a97b4264. A temporary process on 127.0.0.1:15023 used the existing validation database and the installed Node 24 binary. Readiness returned HFM001, cloud-standby, the expected candidate commit and no sync enrollment. A checkout request returned HTTP 409. The temporary service was stopped. The original service then reported healthy on f90e846dd1a442b3c333e5e3f657d2856d1e1446.

This was a startup and standby guard test. The Windows release gate and POS regression workflow failed on this commit and the preceding ef93a5c. Review failed test logs before promotion. The added browser receipt helper needs failure-path testing and a physical printer drill. Shop restore, matching baseline, enrollment and end-to-end sync are pending.

### Published release 62a19da verified in Lightsail staging

Both GitHub checks passed for 62a19dad4daba086ffb944d72ce4af2494a046c0. On 10 November the published Linux zip was downloaded on Lightsail and its SHA-256 matched GitHub (96459329399c933b1b1dd608c3891e0c21022cf304b10d2ef8361199b32334dc). The staged copy in /home/ubuntu/hfm-staging/62a19dad4daba086ffb944d72ce4af2494a046c0 served its frontend HTML, passed database readiness with the HFM001 standby role on loopback port 15023, and refused checkout with HTTP 409. The temporary service was stopped and the existing standby reported healthy on f90e846. Sync and recovery enrollment are pending. These checks used the cloud validation database. Shop backup restore, disconnected checkout, counter printing, and reconciliation after a switch still require separate verification.

### Cashier handoff drill on Lightsail

Two detached databases represented the shop and cloud. The older cloud validation backup lacked `invoices.customer_remarks`, and checkout rolled back. The drill added the release's column definition to both disposable copies. Check schema compatibility on a detached restore before commissioning; never rely on the sign-in page alone. The cloud startup safeguard and secure counter launcher are in [POS PR #2](https://github.com/badisaramesh-code/badizo-pos/pull/2).

The SERVER test session switched billing to the cloud copy. A disposable COUNTER account signed in with its own password. The recovery endpoint denied its activation request with HTTP 403. The cashier billed one item for ₹12 cash, then SERVER switched billing back. Both databases contained one ₹12 payment and nine units remaining from ten. The cashier drill then returned the item on the local copy. On the next switch the cloud showed RETURNED and stock of ten. The patched standby rejected the old invoice schema and passed readiness on a migrated copy. This was a controlled transfer between two POS processes on Lightsail. Real counter enrollment, printing, a current shop restore and rehearsal with the main PC unavailable are still required.

In a separate drill both copies changed the same retail price while the wholesale price was held fixed. The owner reviewed the conflict, both copies converged and the outstanding event queues emptied. Exchanges, free promotions and loyalty redemption have separate reconciliation requirements. Live shop sync is still disabled.

The final run used validator d95fdd4718e0516049ced6ba037eade7540afe1e with the 038100d backend and exited 0. It also checked duplicate checkout recovery, returns and cancellations, lost activation replies, financial corrections and the restored-local sync block. The temporary databases, MySQL users, fixture directories and test listeners were removed. The original cloud standby passed readiness on f90e846. Lightsail retained the result under ~/hfm-staging/qa-62a19dad4daba086ffb944d72ce4af2494a046c0/evidence/final.log. [GitHub regression results](https://github.com/badisaramesh-code/badizo-pos/actions/runs/42838300644).

### Running release on 10 November 2026 after closing

The Windows shop service and Lightsail standby both reported commit 0a8158339a3169be489613b89073d9d9f3cd9cf2. Windows runs the verified published package from Program Files. Its existing working directory supplies the shop configuration. Barcode templates and output use the shop barcode folder. The previous installation remains at D:\badizo-pos-main. Editing that checkout does not update the running release.

The cloud serves the restored closing snapshot in standby. The local and restored cloud databases each matched all eleven business reconciliation checks. Live synchronization is pending. The shop LAN readiness endpoint, local login options and released frontend passed after restarting BadizoServer.

The shop-specific activation script is archived under config. For rollback of this release during a maintenance window, stop BadizoServer, restore its NSSM AppParameters to server.js and remove the three release identity variables added under AppEnvironmentExtra, then start the service and verify its health. Keep the database and shop configuration in place.
