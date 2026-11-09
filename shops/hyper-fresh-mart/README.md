# Hyper Fresh Mart (HFM001)

This folder records the private connection for this shop. Read IMPLEMENTED.txt for the installation record and network rollback. Evidence files cited there are on the installation PC. No POS service loads this folder. Do not reuse these identities or addresses as defaults for another shop. Give each shop its own ID, database, credentials, CA and peer keys; give every counter its own peer key.

## What can be restored

The two .public files identify the enrolled WireGuard peers. The PEM files contain only public certificates. Check the CA fingerprint in IMPLEMENTED.txt against a separately trusted record before installing trust. The templates are for reconstructing settings; they do not grant access. This folder does not contain a sales database, passwords, or a bootable server backup.

The shop WireGuard private key can be backed up encrypted to a recovery public key or passphrase kept independently of Git and of the shop PC. Never commit an actual tunnel .conf, private key, PFX, .env, database dump, or recovery password. When replacing lost hardware, revoke its peer and enroll a new identity if compromise is possible. Never run a restored identity and the original at the same time.

The CA signing key is non-exportable in the SERVER Windows user profile. Its public PEM cannot sign renewals. If the PC is lost, issue a new shop CA, distribute verified trust to the counters and sync service, reissue the server certificate, verify access, then retire the old CA. Cloud WireGuard and TLS private keys remain on Lightsail. If lost, generate new keys there, update the enrolled clients' peer settings through a trusted channel and reissue the leaf certificate. Do not publish cloud host secrets to Git. Rehearse recovery on separate machines.

## Local sales now; cloud sales later

Local billing must continue if internet, VPN, sync, or Lightsail is down. Keep local checkout independent of cloud replies. Ship cloud support disabled by default. Test on a restored copy of the shop database using the actual shop customizations before any live update. Exercise checkout, returns, payments, reports, stock, receipts and printers, counter reconnect, and a simulated cloud outage. Reconcile totals, retry handling and any sync gaps.

To make cloud the primary billing server: enroll every required counter and test its printer/scanner, restore a backup independently, test peak counter load, verify coverage of every business module and arrange a second internet path if continuous billing during an ISP outage is needed. Schedule a short write pause, resolve pending counter bills, stop local writes, verify a final matching baseline and totals, then enable cloud writes and direct counters to cloud. Never let both servers issue bills independently. To return to local after any cloud sale, first stop cloud writes and reconcile those sales back to local. Merely changing shortcuts is not a rollback.

As of 9 November 2026 only the private connection was verified. Sync and cloud billing are not active. No production cutover is authorized by this record.

Run Backup-ShopKey.ps1 interactively on the original server to make a passphrase-encrypted copy of its WireGuard private key. Choose a long, unique recovery passphrase and keep it in an owner-controlled password manager accessible without this PC. The script checks decryption before producing shop-server.private.gpg. Only that encrypted file should be committed after the check. On a replacement machine decrypt with GnuPG into an administrator-only directory outside Git, then verify the derived WireGuard public key matches shop-server.public before using it. This covers only the shop VPN identity.
