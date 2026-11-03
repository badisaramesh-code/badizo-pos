const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const jwt = require('jsonwebtoken');
const { JWT_SECRET } = require('../middleware/auth');
let writes = [], affectedRows = 1;
require.cache[require.resolve('../config/db')] = { exports: {
  query: async (sql, params) => { writes.push({ sql, params }); return [{ affectedRows }]; }
} };
const router = require('../routes/books');

test('manual edits and deletes validate input, require book access and restrict writes to manual entries', async () => {
  const app = express(); app.use(express.json()); app.use('/books', router);
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const url = `http://127.0.0.1:${server.address().port}/books/named-ledgers/manual/1`;
  const call = (method, body, role = 'SERVER') => fetch(url, {
    method, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + jwt.sign({ id: 1, username: 'test', role }, JWT_SECRET) },
    ...(body ? { body: JSON.stringify(body) } : {})
  });
  const valid = { entry_date: '2026-11-01', details: ' HDFC ', remarks: ' receipt ', direction: 'CR', amount: 250 };
  try {
    assert.equal((await call('PUT', valid)).status, 200);
    assert.match(writes[0].sql, /WHERE id = \? AND source_type = \?/);
    assert.deepEqual(writes[0].params, ['2026-11-01', 'HDFC', 'HDFC', 'receipt', 'CR', 250, 1, 'NAMED_LEDGER_MANUAL']);
    for (const change of [{ entry_date: '2026-02-30' }, { amount: -1 }, { amount: 'NaN' }, { details: '' }, { direction: 'OTHER' }]) {
      assert.equal((await call('PUT', { ...valid, ...change })).status, 400);
    }
    assert.equal((await call('PUT', valid, 'COUNTER')).status, 403);
    assert.equal((await call('DELETE', null, 'COUNTER')).status, 403);
    assert.equal(writes.length, 1);
    assert.equal((await call('DELETE')).status, 200);
    assert.match(writes[1].sql, /DELETE.*WHERE id = \? AND source_type = \?/);
    assert.deepEqual(writes[1].params, [1, 'NAMED_LEDGER_MANUAL']);
    affectedRows = 0;
    assert.equal((await call('PUT', valid)).status, 404);
    assert.equal((await call('DELETE')).status, 404);
  } finally { await new Promise(resolve => server.close(resolve)); }
});
