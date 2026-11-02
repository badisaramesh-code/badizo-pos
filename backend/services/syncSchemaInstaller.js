const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const digest = value => crypto.createHash('sha256').update(value).digest('hex');
const normalizeSql = value => value.replace(/\r\n/g, '\n');
const identifier = value => {
  if (!/^[a-z][a-z0-9_]{0,63}$/.test(value)) throw Error('Invalid migration identifier.');
  return '`' + value + '`';
};
function statements(sql) {
  return sql.replace(/^\s*--.*$/gm, '').split(';').map(s => s.trim()).filter(Boolean).map(statement => {
    const match = /^CREATE TABLE (?:IF NOT EXISTS )?(sync_[a-z_]+)\s*\(/.exec(statement);
    if (!match || !/\) ENGINE=InnoDB$/i.test(statement)) throw Error('Only additive sync table migrations are permitted.');
    return {table: match[1], sql: statement.replace('CREATE TABLE IF NOT EXISTS ', 'CREATE TABLE ')};
  });
}
async function loadManifest(directory) {
  const manifest = JSON.parse(await fs.readFile(path.join(directory, 'sync-release.json'), 'utf8'));
  if (manifest.schemaVersion !== 1 || manifest.contractVersion !== 1 || manifest.mysqlSeries !== '8.0' || !Array.isArray(manifest.migrations) || !manifest.migrations.length) throw Error('Unsupported sync release manifest.');
  const seen = new Set(), tables = new Set(), migrations = [];
  for (const item of manifest.migrations) {
    if (!/^optional-sync-[a-z-]+\.sql$/.test(item.file) || seen.has(item.file)) throw Error('Invalid migration manifest entry.');
    seen.add(item.file);
    const sql = normalizeSql(await fs.readFile(path.join(directory, item.file), 'utf8'));
    if (digest(sql) !== item.sha256) throw Error('Migration checksum mismatch: ' + item.file);
    const steps = statements(sql);
    if (!steps.length) throw Error('Empty migration.');
    for (const step of steps) { if (tables.has(step.table)) throw Error('Duplicate migration table.'); tables.add(step.table); }
    migrations.push({...item, steps});
  }
  return {manifest, migrations};
}
function definition(row) {
  const sql = Object.values(row).find(value => typeof value === 'string' && /^CREATE /.test(value));
  if (!sql) throw Error('Cannot inspect table definition.');
  return sql.replace(/^CREATE (?:TEMPORARY )?TABLE `[^`]+`/, 'CREATE TABLE `verified`').replace(/ AUTO_INCREMENT=\d+/g, '');
}
async function verifyTable(connection, step) {
  // Let this exact MySQL version normalize the expected DDL. No business
  // table is touched, and a mismatched pre-existing sync table is never adopted.
  const probe = 'sync_probe_' + crypto.randomBytes(8).toString('hex');
  await connection.query(step.sql.replace(/^CREATE TABLE sync_[a-z_]+/, 'CREATE TEMPORARY TABLE ' + identifier(probe)));
  try {
    const [expected] = await connection.query('SHOW CREATE TABLE ' + identifier(probe));
    const [actual] = await connection.query('SHOW CREATE TABLE ' + identifier(step.table));
    if (definition(actual[0]) !== definition(expected[0])) throw Error('Schema differs from release: ' + step.table);
  } finally { await connection.query('DROP TEMPORARY TABLE IF EXISTS ' + identifier(probe)); }
}
async function installSyncSchema({connection, directory, expectedDatabase, apply = false}) {
  const {manifest, migrations} = await loadManifest(directory);
  const [[state]] = await connection.query('SELECT DATABASE() AS name, VERSION() AS version');
  if (state.name !== expectedDatabase || !/^8\.0\./.test(state.version)) throw Error('Expected database or supported MySQL version does not match.');
  const lock = 'badizo-sync-install:' + digest(expectedDatabase).slice(0, 32);
  const [[acquired]] = await connection.execute('SELECT GET_LOCK(?,0) AS acquired', [lock]);
  if (Number(acquired.acquired) !== 1) throw Error('Another sync installation is running.');
  try {
    const [existing] = await connection.query('SELECT TABLE_NAME AS name FROM information_schema.tables WHERE table_schema=DATABASE()');
    const names = new Set(existing.map(row => row.name));
    const steps = migrations.flatMap(m => m.steps.map(s => ({...s, checksum: m.sha256, migration: m.file})));
    // Preflight all existing definitions before any persistent change.
    for (const step of steps) if (names.has(step.table)) await verifyTable(connection, step);
    const ledger = {table: 'sync_schema_migrations', sql: 'CREATE TABLE sync_schema_migrations (table_name VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY, migration_name VARCHAR(100) NOT NULL, checksum CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL, state VARCHAR(16) NOT NULL, verified_at TIMESTAMP(6) NULL) ENGINE=InnoDB'};
    if (names.has(ledger.table)) await verifyTable(connection, ledger);
    const recorded = names.has(ledger.table) ? (await connection.query('SELECT * FROM sync_schema_migrations'))[0] : [];
    for (const row of recorded) {
      const step = steps.find(s => s.table === row.table_name);
      if (!step || row.checksum !== step.checksum || row.migration_name !== step.migration || !['started','verified'].includes(row.state)) throw Error('Installed migration history differs from this release.');
      if (row.state === 'verified' && !names.has(row.table_name)) throw Error('Previously installed sync table is missing; recovery inspection required.');
    }
    const plan = steps.map(step => ({table: step.table, action: names.has(step.table) ? 'verify' : 'create'}));
    if (!apply) return {applied: false, contractVersion: manifest.contractVersion, plan};
    // DDL commits implicitly. Journal each table separately; a restart verifies
    // a created table before completing its interrupted journal entry.
    if (!names.has(ledger.table)) await connection.query(ledger.sql);
    for (const step of steps) {
      await connection.execute("INSERT INTO sync_schema_migrations (table_name,migration_name,checksum,state) VALUES (?,?,?,'started') ON DUPLICATE KEY UPDATE state='started'", [step.table, step.migration, step.checksum]);
      if (!names.has(step.table)) await connection.query(step.sql);
      await verifyTable(connection, step);
      await connection.execute("UPDATE sync_schema_migrations SET state='verified',verified_at=CURRENT_TIMESTAMP(6) WHERE table_name=?", [step.table]);
    }
    return {applied: true, contractVersion: manifest.contractVersion, plan, enrollmentChanged: false};
  } finally { await connection.execute('SELECT RELEASE_LOCK(?)', [lock]); }
}
module.exports = {installSyncSchema, loadManifest, statements, definition};
