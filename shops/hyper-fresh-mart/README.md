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

### Owner checklist for a local server failure (after commissioning)

1. If local counters still work and only the internet or VPN has failed, continue local sales. Check sync status after connectivity returns.
2. If the local server has failed, stop billing on every local counter, including the server PC. Prevent it from accepting new sales when it restarts. Record the last known bill on each counter, including any payment taken without a confirmed receipt.
3. Check the last successful transfer on the standby and compare the latest invoices with counter records. Identify the interval that may be missing. Look up uncertain payments and bills before entering them again. If another counter may still be billing locally, keep the cloud in standby.
4. Once all local billing has stopped and the owner has reviewed the gap, use the tested emergency activation procedure. Open the emergency shortcut on enrolled counters. Verify the shop and counter shown before taking the first payment.
5. To return to local, stop new cloud bills, finish pending payments, transfer and reconcile emergency sales, stock and payment totals. Account for any local sales made after the last successful sync. Reopen local billing only after the figures match and the cloud is back in standby.

### Commissioning after closing

Test the merged release on an isolated restored backup, including simultaneous local checkouts with cloud disconnected. Verify sync coverage and counter peripherals. Then schedule the live baseline, enable sync and rehearse the switch and return. Record the last successful transfer time and expected recovery gap. Keep the independent Drive backups running.

Run Backup-ShopKey.ps1 interactively on the original server to make a passphrase-encrypted copy of its WireGuard private key. Choose a long, unique recovery passphrase and keep it in an owner-controlled password manager accessible without this PC. The script checks decryption before producing shop-server.private.gpg. Only that encrypted file should be committed after the check. On a replacement machine decrypt with GnuPG into an administrator-only directory outside Git, then verify the derived WireGuard public key matches shop-server.public before using it. This covers only the shop VPN identity.
