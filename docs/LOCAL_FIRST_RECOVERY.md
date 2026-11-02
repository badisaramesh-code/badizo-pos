# Local-first recovery contract

Local Windows/MySQL is the primary shop billing environment. Internet or management-dashboard failure must not prevent ordinary local checkout. Cloud is the emergency environment for local machine/OS failure. Initial scheduled synchronization is daily at 20:30 Asia/Kolkata; this leaves a possible unsynced interval up to the last successful transfer. Google Drive full backups remain independent.

After Windows corruption, recovery can use either a verified cloud export or a downloaded Google Drive SQL backup. A retained backup already downloaded locally is needed if internet is unavailable. A Drive file that has not been downloaded cannot be fetched without connectivity. Restoring software and a compatible MySQL service is a prerequisite; restoring database data cannot repair Windows itself.

Both sources feed the same staged local restore workflow: verify source identity/checksum, decompress, restore into an isolated database with narrowly scoped credentials, verify schema/data, preserve any surviving local database, configure local machine settings, test billing/printing, then explicitly activate local. The restore account must be unable to modify other databases: SQL dumps are executable inputs, and a checksum is not an authorization or SQL safety check.

`recoveryBackupArtifact.js` implements input preparation only. It streams SQL/gzip, checks the expected SHA-256, detects gzip corruption, enforces an expanded-size bound and writes to an exclusively created directory. Its manifest explicitly states that shop identity, SQL restore and activation are unverified. The output directory must be privately protected by the deployment process, particularly on Windows where POSIX mode flags alone do not establish NTFS access controls.

Sync must preserve shop transaction identity. If local and cloud have diverged, do not overwrite local automatically. Local is preferred for eligible conflicting product values; cloud sales still need preservation, stock needs movement reconciliation, and financial conflicts need explicit handling. Restoring cloud wholesale is a separately selected recovery option for loss of local data, not a merge.

## Incomplete work

No sync transfer, source downloader, restricted restore executor, switch executor or emergency local override is enabled by this module. The current production local server and cloud standby are not changed. Existing backup routes remain separate and must not be described as this staged restore workflow. Integration must include interrupted restore, source/shop mismatch, corrupt backup, duplicate events, inconsistent schema, loss of connectivity, Windows startup and real printer acceptance tests.
