'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

// Shared by standalone scheduled jobs, which must follow the active recovery DB
// rather than continuing to dump an old database named in the original .env.
function loadBackupRuntimeBinding(env = process.env) {
  if (!env.BADIZO_RUNTIME_BINDING) return { bound: false, assertUnchanged() {} };
  const file = env.BADIZO_RUNTIME_BINDING;
  if (!path.isAbsolute(file)) throw Error('Backup runtime binding must be an absolute protected path.');
  function read() {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink()) throw Error('Backup runtime binding must be a protected regular file.');
    const raw = fs.readFileSync(file, 'utf8'), value = JSON.parse(raw);
    if (value.schemaVersion !== 1 || value.shopId !== env.BADIZO_SHOP_ID ||
        !/^[a-f0-9-]{36}$/.test(value.activationId || '') || value.phase !== 'active' || value.billingMode !== 'active' ||
        !['localhost','127.0.0.1','::1'].includes(value.database?.host) ||
        !/^[a-zA-Z0-9_]{1,64}$/.test(value.database?.database || '') ||
        typeof value.database.user !== 'string' || typeof value.database.password !== 'string' ||
        (value.database.port !== undefined && (!Number.isInteger(value.database.port) || value.database.port < 1 || value.database.port > 65535))) {
      throw Error('Backup is blocked while billing authority is changing or belongs to another shop.');
    }
    return { value, fingerprint: crypto.createHash('sha256').update(raw).digest('hex') };
  }
  const initial = read(), database = initial.value.database;
  Object.assign(env, { DB_HOST: database.host, DB_PORT: String(database.port || 3306), DB_USER: database.user,
    DB_PASSWORD: database.password, DB_NAME: database.database });
  return { bound: true, databaseName: database.database, activationId: initial.value.activationId,
    assertUnchanged() { if (read().fingerprint !== initial.fingerprint) throw Error('Billing database changed during backup; this file must not be advertised as the current backup.'); } };
}
module.exports = { loadBackupRuntimeBinding };
