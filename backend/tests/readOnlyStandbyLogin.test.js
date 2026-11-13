'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const express = require('express');
test('cloud owner can log in with a valid stored password when optional session audit is read-only', async t => {
  const password = 'fixture-only-strong-password', salt = 'fixture-salt';
  const hash = salt + ':' + crypto.pbkdf2Sync(password, salt, 100000, 64, 'sha512').toString('hex');
  const dbPath = require.resolve('../config/db'); let optionalAuditAttempted = false;
  require.cache[dbPath] = { exports: { query: async sql => {
    if (sql.includes('FROM users')) return [[{ id: 1, username: 'fixture-owner', password_hash: hash, role: 'SERVER', counter_no: null, is_active: 1 }]];
    if (sql.includes('INSERT INTO user_session_events')) { optionalAuditAttempted = true; throw Object.assign(Error('Read only fixture'), { code: 'ER_OPTION_PREVENTS_STATEMENT' }); }
    throw Error('Unexpected login query');
  } } };
  const before = process.env.BADIZO_NODE_ROLE; process.env.BADIZO_NODE_ROLE = 'cloud-standby';
  t.after(() => { if (before === undefined) delete process.env.BADIZO_NODE_ROLE; else process.env.BADIZO_NODE_ROLE = before; });
  const app = express(); app.use(express.json()); app.use('/auth', require('../routes/auth'));
  const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const response = await fetch('http://127.0.0.1:' + server.address().port + '/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'fixture-owner', password }) });
  assert.equal(response.status, 200); const body = await response.json(); assert.equal(body.user.role, 'SERVER'); assert.ok(body.token);
  assert.equal(optionalAuditAttempted, true);
});
