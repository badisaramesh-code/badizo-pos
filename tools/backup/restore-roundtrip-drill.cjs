'use strict';
// Explicit lab only: a NEW MySQL data directory and port, never the shop service.
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const os = require('node:os');
const { spawn, execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { once } = require('node:events');
const mysql = require('../../backend/node_modules/mysql2/promise');
const { prepareRecoveryBackup } = require('../../backend/services/recoveryBackupArtifact');
const { prepareCandidateSchema } = require('../../backend/services/recoveryCandidateSchema');
const { prepareRecoveryInvoiceNumbers } = require('../../backend/services/recoveryInvoiceNumbers');
const { createPrivateMysqlDefaults } = require('../../backend/scripts/privateMysqlDefaults');
const command = promisify(execFile);
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function main() {
  const [mode, backup, python] = process.argv.slice(2);
  if (mode !== '--isolated' || !path.isAbsolute(backup || '') || !path.isAbsolute(python || '') || process.platform !== 'win32') throw Error('Use --isolated ABSOLUTE_SQL_OR_GZ ABSOLUTE_PYTHON.');
  const base = 'C:/Program Files/MySQL/MySQL Server 8.0';
  const root = path.resolve(__dirname, '../../../restore-roundtrip-' + crypto.randomUUID());
  const workspace = path.resolve(__dirname, '../../../..');
  if (!root.startsWith(workspace + path.sep)) throw Error('Lab directory escaped workspace.');
  await fs.mkdir(root);
  const identity = (await command('whoami.exe', [], { windowsHide: true })).stdout.trim();
  await command('icacls.exe', [root, '/inheritance:r', '/grant:r', identity + ':(OI)(CI)F', 'SYSTEM:(OI)(CI)F'], { windowsHide: true });
  const data = path.join(root, 'data'); await fs.mkdir(data);
  const exe = path.join(base, 'bin/mysqld.exe'), port = 34083;
  const password = crypto.randomBytes(24).toString('hex'), stagePassword = crypto.randomBytes(24).toString('hex');
  const database = 'badizo_recovery_' + crypto.randomBytes(8).toString('hex');
  const user = 'fixture_' + crypto.randomBytes(5).toString('hex');
  let child, admin, scoped, defaults;
  function launch(args) {
    const process = spawn(exe, args, { windowsHide: true, stdio: 'ignore' });
    process.on('error', () => {});
    try { os.setPriority(process.pid, os.constants.priority.PRIORITY_BELOW_NORMAL); } catch {}
    return process;
  }
  try {
    const init = launch(['--no-defaults', '--initialize-insecure', '--basedir=' + base, '--datadir=' + data]);
    const [code] = await once(init, 'exit'); if (code !== 0) throw Error('Lab initialization failed.');
    child = launch(['--no-defaults', '--basedir=' + base, '--datadir=' + data, '--port=' + port, '--bind-address=127.0.0.1',
      '--mysqlx=OFF', '--skip-log-bin', '--innodb-buffer-pool-size=32M', '--innodb-redo-log-capacity=64M',
      '--max-connections=8', '--performance-schema=OFF', '--log-error=' + path.join(root, 'mysql-error.log')]);
    const until = Date.now() + 45000;
    while (!admin && Date.now() < until) {
      if (child.exitCode !== null) throw Error('Owned lab process stopped.');
      try { admin = await mysql.createConnection({ host: '127.0.0.1', port, user: 'root', password: '', connectTimeout: 1000 }); }
      catch { await wait(150); }
    }
    if (!admin) throw Error('Lab MySQL did not become ready.');
    const [[location]] = await admin.query('SELECT @@datadir AS directory');
    if (path.resolve(location.directory) !== path.resolve(data)) throw Error('Refusing to modify a MySQL instance not owned by this lab.');
    await admin.query("ALTER USER 'root'@'localhost' IDENTIFIED BY ?", [password]);
    await admin.query('CREATE DATABASE `' + database + '`');
    await admin.query('CREATE USER ?@\'127.0.0.1\' IDENTIFIED BY ?', [user, stagePassword]);
    await admin.query('GRANT ALL PRIVILEGES ON `' + database.replace(/_/g, '\\_') + '`.* TO ?@\'127.0.0.1\'', [user]);
    const digest = crypto.createHash('sha256');
    const stream = require('node:fs').createReadStream(backup);
    for await (const chunk of stream) digest.update(chunk);
    const sourceSha256 = digest.digest('hex'), artifact = path.join(root, 'artifact');
    await prepareRecoveryBackup({ sourcePath: backup, outputDirectory: artifact, expectedSha256: sourceSha256, shopId: 'HFM001', source: 'google-drive' });
    defaults = createPrivateMysqlDefaults({ DB_HOST: '127.0.0.1', DB_PORT: String(port), DB_USER: 'root', DB_PASSWORD: password });
    const config = { shopId: 'HFM001', database, host: '127.0.0.1', port, user, password: stagePassword,
      sourceDatabase: 'badizo_pos', artifactDirectory: artifact, mysqlPath: path.join(base, 'bin/mysql.exe'), triggerInstallerDefaultsFile: defaults.file };
    const file = path.join(root, 'restore-config.json'); await fs.writeFile(file, JSON.stringify(config), { flag: 'wx', mode: 0o600 });
    const result = await command(python, [path.resolve(__dirname, '../fleet/restore-staged.py'), file], { windowsHide: true, timeout: 1800000, maxBuffer: 65536 });
    scoped = await mysql.createConnection({ host: '127.0.0.1', port, user, password: stagePassword, database, supportBigNumbers: true, bigNumberStrings: true });
    const schema = await prepareCandidateSchema(scoped, config);
    const numbers = await prepareRecoveryInvoiceNumbers({ candidateConnection: scoped, nodeRole: 'cloud-standby', operationId: crypto.randomUUID() });
    const report = { isolated: true, productionDatabaseTouched: false, sourceSha256,
      sqlRestore: JSON.parse(result.stdout), schema, invoiceNumbersVerified: numbers.invoiceNumbersVerified, passed: true };
    await fs.writeFile(path.join(root, 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ fixture: root, passed: true, restoredInvoices: schema.summary.invoices, invoiceNumbersVerified: true }));
  } finally {
    if (scoped) await scoped.end().catch(() => {});
    if (admin) { await admin.query('SHUTDOWN').catch(() => {}); await admin.end().catch(() => {}); }
    if (child && child.exitCode === null) { await Promise.race([once(child, 'exit'), wait(10000)]); if (child.exitCode === null) child.kill(); }
    if (defaults) defaults.cleanup();
    // This private lab is retained as evidence; no production path is deleted.
  }
}
main().catch(error => { console.error('Isolated restore drill failed: ' + (error.code || error.message)); process.exitCode = 1; });
