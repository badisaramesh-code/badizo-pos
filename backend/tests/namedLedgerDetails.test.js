const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const jwt = require('jsonwebtoken');
const { JWT_SECRET } = require('../middleware/auth');
let rows, updates, commits, rollbacks, failUpdate;
const connection = {
  beginTransaction: async () => {}, commit: async () => { commits++; },
  rollback: async () => { rollbacks++; }, release: () => {},
  query: async (sql, params) => {
    if (sql.startsWith('SELECT cle.id')) return [rows];
    if (sql.startsWith('SELECT source_type') || sql.startsWith('SELECT * FROM counter_cash_ledger_entries')) return [rows.filter(row => row.id === 1).map(row => ({ ...row, source_type: 'NAMED_LEDGER_MANUAL' }))];
    if (sql.startsWith('UPDATE counter_cash_ledger_entries')) {
      if (failUpdate) throw new Error('test write failure');
      updates.push({ sql, params });
    }
    return [[]];
  }
};
require.cache[require.resolve('../config/db')] = { exports: { getConnection: async () => connection } };
const router = require('../routes/books');
test('GENERAL details edits route to existing accounts without new monetary postings', async () => {
  const app = express(); app.use(express.json()); app.use('/books', router);
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const base = 'http://127.0.0.1:' + server.address().port + '/books/named-ledgers/1/details';
  const call = (body, role = 'SERVER') => fetch(base, { method: 'PATCH', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + jwt.sign({ id: 1, username: 'test', role }, JWT_SECRET) }, body: JSON.stringify(body) });
  try {
    rows = [{ id: 1, account_name: 'GENERAL', details: 'Original', direction: 'CR', amount: 100 }, { id: 2, account_name: 'BIKE REPAIR' }];
    updates = []; commits = 0; rollbacks = 0;
    let response = await call({ details: ' bike repair ', to: '2026-09-18' });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).account_name, 'BIKE REPAIR');
    assert.deepEqual(updates[0].params, ['bike repair', 'BIKE REPAIR', 1]);
    assert.equal(updates[0].sql, 'UPDATE counter_cash_ledger_entries SET named_ledger_details = ?, named_ledger_account = ? WHERE id = ?');
    assert.equal(commits, 1);
    response = await call({ details: 'Corrected description', to: '2026-09-18' });
    assert.equal((await response.json()).account_name, 'GENERAL');
    const count = updates.length;
    assert.equal((await call({ details: 'BIKE REPAIR', to: '2026-09-18', amount: 999 })).status, 400);
    assert.equal((await call({ details: ' ', to: '2026-09-18' })).status, 400);
    assert.equal((await call({ details: 'x'.repeat(256), to: '2026-09-18' })).status, 400);
    assert.equal((await call({ details: 'text', to: '2026-09-18' }, 'COUNTER')).status, 403);
    rows[0].account_name = 'BIKE REPAIR';
    assert.equal((await call({ details: 'text', to: '2026-09-18' })).status, 409);
    rows = [];
    assert.equal((await call({ details: 'text', to: '2026-09-18' })).status, 409);
    assert.equal(updates.length, count);
    rows = [{ id: 1, account_name: 'GENERAL' }]; failUpdate = true;
    assert.equal((await call({ details: 'text', to: '2026-09-18' })).status, 500);
    assert.equal(rollbacks, 3);
  } finally { await new Promise(resolve => server.close(resolve)); }
});
