const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const jwt = require('jsonwebtoken');
const { JWT_SECRET } = require('../middleware/auth');
const entries = new Map([
  ['1', { source_type: 'MANUAL_CASH_USAGE', amount: 100 }],
  ['2', { source_type: 'COUNTER_HANDOVER', amount: 500 }],
  ['3', { source_type: 'NAMED_LEDGER_MANUAL', amount: 580000, account_name: 'BR VADAKAM' }]
]);
require.cache[require.resolve('../config/db')] = { exports: { query: async (sql, params) => {
  if (sql.includes('audit_logs')) return [{}];
  assert.match(sql, /source_type IN \('MANUAL_CASH_USAGE', 'NAMED_LEDGER_MANUAL'\)/);
  const id = String(params[params.length - 1]);
  const entry = entries.get(id);
  if (!entry || !['MANUAL_CASH_USAGE', 'NAMED_LEDGER_MANUAL'].includes(entry.source_type)) return [{ affectedRows: 0 }];
  if (sql.startsWith('DELETE')) entries.delete(id);
  else Object.assign(entry, { date: params[0], counter_no: params[1], details: params[3], direction: params[4], amount: params[5] });
  return [{ affectedRows: 1 }];
} } };
const router = require('../routes/counterCashLedger');

test('manual entries can be corrected and deleted; handovers and unauthorized access are protected', async () => {
  const app = express();
  app.use(express.json());
  app.use('/ledger', router);
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}/ledger`;
  const payload = { date: '2026-10-16', counter_no: '', details: 'Corrected deposit', cr_amount: 250 };
  async function call(id, method, body, role = 'SERVER') {
    return fetch(`${base}/${id}`, { method, headers: { Authorization: `Bearer ${jwt.sign({ role, username: 'test' }, JWT_SECRET)}`, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
  }
  try {
    assert.equal((await call(1, 'PUT', payload, 'COUNTER')).status, 403);
    assert.equal((await call(1, 'DELETE', null, 'COUNTER')).status, 403);
    assert.equal((await call(1, 'PUT', { ...payload, dr_amount: 10 })).status, 400);
    assert.equal((await call(1, 'PUT', { ...payload, cr_amount: 0 })).status, 400);
    assert.equal((await call(1, 'PUT', { ...payload, details: '' })).status, 400);
    assert.equal((await call(2, 'PUT', payload)).status, 404);
    assert.equal((await call(2, 'DELETE')).status, 404);
    assert.equal(entries.get('2').amount, 500);
    assert.equal((await call(3, 'PUT', { ...payload, details: 'Corrected BR entry', cr_amount: 10 })).status, 200);
    assert.equal(entries.get('3').amount, 10);
    assert.equal(entries.get('3').account_name, 'BR VADAKAM');
    assert.equal((await call(3, 'DELETE')).status, 200);
    assert.equal(entries.has('3'), false);
    assert.equal((await call(1, 'PUT', payload)).status, 200);
    assert.equal(entries.get('1').amount, 250);
    assert.equal(entries.get('1').direction, 'CR');
    assert.equal(entries.get('1').counter_no, null);
    assert.equal((await call(1, 'DELETE')).status, 200);
    assert.equal(entries.has('1'), false);
    assert.equal((await call(1, 'DELETE')).status, 404);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});
