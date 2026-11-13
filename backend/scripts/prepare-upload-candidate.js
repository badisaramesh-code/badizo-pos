'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const mysql = require('mysql2/promise');
const { prepareCandidateSchema } = require('../services/recoveryCandidateSchema');
async function main() {
  const file = process.argv[2];
  if (process.argv.length !== 3 || !path.isAbsolute(file || '')) throw Error('Use the protected candidate restore configuration path.');
  const stat = await fs.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || (process.platform !== 'win32' && (stat.mode & 0o077))) throw Error('Candidate configuration must be a protected regular file.');
  const config = JSON.parse(await fs.readFile(file, 'utf8'));
  if (!['127.0.0.1', 'localhost', '::1'].includes(config.host) || !/^badizo_recovery_[a-z0-9]{8,32}$/.test(config.database || '') ||
      typeof config.user !== 'string' || typeof config.password !== 'string') throw Error('Use loopback candidate-only credentials.');
  const connection = await mysql.createConnection({ host: config.host, port: Number(config.port || 3306), user: config.user,
    password: config.password, database: config.database, multipleStatements: false, connectTimeout: 10000, supportBigNumbers: true, bigNumberStrings: true });
  let locked = false;
  try {
    const [[lock]] = await connection.execute('SELECT GET_LOCK(?,0) AS acquired', ['badizo-rebuild:' + config.database]);
    if (Number(lock.acquired) !== 1) throw Error('The recovery candidate is in use.');
    locked = true;
    const result = await prepareCandidateSchema(connection, config);
    process.stdout.write(JSON.stringify(result) + '\n');
  } finally {
    if (locked) await connection.execute('SELECT RELEASE_LOCK(?)', ['badizo-rebuild:' + config.database]).catch(() => {});
    await connection.end();
  }
}
main().catch(error => { console.error('Candidate preparation failed: ' + (error.code || error.message)); process.exitCode = 1; });
