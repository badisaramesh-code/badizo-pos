const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1']);

function validateUpgradeDatabase(credentials, binding) {
  const runtime = binding?.database;
  if (!runtime || !credentials || !LOOPBACK.has(runtime.host) || !LOOPBACK.has(credentials.host)
    || !/^[A-Za-z0-9_]+$/.test(runtime.database || '') || credentials.database !== runtime.database
    || (credentials.port !== undefined && credentials.port !== 3306)
    || (runtime.port !== undefined && runtime.port !== 3306)) {
    throw Error('Upgrade database differs from the supported local runtime binding.');
  }
  return runtime;
}

async function verifyUpgradeDatabaseIdentity(installer, runtime) {
  const sql = 'SELECT @@server_uuid AS serverUuid, DATABASE() AS databaseName';
  const [[[installed]], [[running]]] = await Promise.all([installer.query(sql), runtime.query(sql)]);
  if (!installed?.serverUuid || installed.serverUuid !== running?.serverUuid
    || installed.databaseName !== running.databaseName) {
    throw Error('Installer and POS runtime do not address the same MySQL database.');
  }
}

function upgradeDumpArguments(defaultsFile, runtime) {
  // CLI endpoint options override any stale host/socket/port in the password file.
  // Installer/backup accounts may legitimately differ from the runtime account.
  return ['--defaults-extra-file=' + defaultsFile, '--protocol=TCP', '--host=' + runtime.host, '--port=3306',
    '--single-transaction', '--routines', '--triggers', '--events', '--hex-blob', runtime.database];
}

module.exports = { validateUpgradeDatabase, verifyUpgradeDatabaseIdentity, upgradeDumpArguments };
