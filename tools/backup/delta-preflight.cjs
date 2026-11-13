'use strict';

// Read-only audit. This command never rotates logs, dumps/restores a database,
// uploads files, updates an archive checkpoint, or installs a scheduled task.
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const mysql = require('../../backend/node_modules/mysql2/promise');
const dotenv = require('../../backend/node_modules/dotenv');

async function backupCoordinate(file) {
  const source = fs.createReadStream(file);
  const decoded = file.endsWith('.gz') ? source.pipe(zlib.createGunzip()) : source;
  let header = '';
  try {
    for await (const chunk of decoded) {
      header += chunk.toString('utf8');
      if (header.length >= 262144) break;
    }
  } finally { source.destroy(); decoded.destroy(); }
  const match = header.match(/(?:SOURCE_LOG_FILE|MASTER_LOG_FILE)\s*=\s*'([^']+)'\s*,\s*(?:SOURCE_LOG_POS|MASTER_LOG_POS)\s*=\s*(\d+)/);
  return { file: path.basename(file), coordinate: match ? { file: match[1], position: Number(match[2]) } : null, restoreVerified: false };
}

async function main() {
  const args = process.argv.slice(2);
  const options = {};
  for (let index = 0; index < args.length; index += 2) {
    if (!['--env-file', '--baseline', '--output'].includes(args[index]) || !args[index + 1]) throw Error('Use --env-file PATH [--baseline SQL_OR_GZ] [--output JSON].');
    options[args[index]] = args[index + 1];
  }
  if (!path.isAbsolute(options['--env-file'] || '')) throw Error('An absolute existing backend .env path is required.');
  const env = dotenv.parse(fs.readFileSync(options['--env-file']));
  const db = await mysql.createConnection({ host: env.DB_HOST || 'localhost', port: Number(env.DB_PORT || 3306), user: env.DB_USER, password: env.DB_PASSWORD, database: env.DB_NAME });
  try {
    const [rows] = await db.query("SHOW VARIABLES WHERE Variable_name IN ('version','log_bin','binlog_format','binlog_row_image','binlog_expire_logs_seconds','gtid_mode','server_uuid')");
    const settings = Object.fromEntries(rows.map(row => [row.Variable_name, row.Value]));
    const [status] = await db.query('SHOW MASTER STATUS');
    const [logs] = await db.query('SHOW BINARY LOGS');
    const [engines] = await db.query('SELECT ENGINE AS engine, COUNT(*) AS tables_count FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_TYPE=\'BASE TABLE\' GROUP BY ENGINE');
    const baseline = options['--baseline'] ? await backupCoordinate(options['--baseline']) : null;
    const blockers = [];
    if (settings.log_bin !== 'ON' || settings.binlog_format !== 'ROW' || settings.binlog_row_image !== 'FULL') blockers.push('Binary log configuration is not ROW/FULL.');
    if (!baseline?.coordinate) blockers.push('No full baseline with an exact binary-log starting coordinate has been supplied.');
    blockers.push('Baseline checksum and isolated baseline-plus-delta restore are not verified by this read-only audit.');
    if (engines.some(row => row.engine !== 'InnoDB')) blockers.push('Non-InnoDB tables need a consistent baseline strategy during the sales pause.');
    const report = {
      checkedAt: new Date().toISOString(), mode: 'READ_ONLY', settings, engines,
      current: status[0] ? { file: status[0].File, position: status[0].Position } : null,
      logs: logs.map(row => ({ file: row.Log_name, size: Number(row.File_size), encrypted: row.Encrypted })),
      baseline, blockers, activationReady: false,
      changedDatabase: false, rotatedLogs: false, uploadedFiles: false, installedSchedule: false
    };
    const json = JSON.stringify(report, null, 2) + '\n';
    if (options['--output']) fs.writeFileSync(options['--output'], json, { flag: 'wx' });
    process.stdout.write(JSON.stringify({ mode: report.mode, binaryLogReady: settings.log_bin === 'ON' && settings.binlog_format === 'ROW' && settings.binlog_row_image === 'FULL', logFiles: report.logs.length, baselineHasCoordinate: !!baseline?.coordinate, blockers, activationReady: false }) + '\n');
  } finally { await db.end(); }
}
main().catch(error => { console.error('Preflight failed: ' + (error.code || error.message)); process.exitCode = 1; });
