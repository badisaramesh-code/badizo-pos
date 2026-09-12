const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const jwt = require('jsonwebtoken');
const { JWT_SECRET } = require('../middleware/auth');
let queries = [];
require.cache[require.resolve('../config/db')] = { exports: { query: async (sql, params) => { queries.push({sql, params}); return [[]]; } } };
const router = require('../routes/reports');
test('HTTP approval flow blocks data before OK and enforces counter ownership', async () => {
  const app = express(); app.use(express.json()); app.use('/reports', router);
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}/reports`;
  const counter = {id: 3, role: 'COUNTER', session_id: 'one', counter_no: 2, username: 'counter2'};
  async function call(path, user, method = 'GET', body, approval) {
    return fetch(base + path, {method, headers: {Authorization: 'Bearer ' + jwt.sign(user, JWT_SECRET), 'Content-Type': 'application/json', ...(approval ? {'X-Report-Approval': approval} : {})}, ...(body ? {body: JSON.stringify(body)} : {})});
  }
  try {
    for (const path of ['/pos-sale-report', '/counter-sale-slip']) assert.equal((await call(path, counter)).status, 403);
    assert.equal(queries.length, 0);
    const params = {from: '2026-09-12', to: '2026-09-12', counter_no: 6};
    const row = await (await call('/approvals', counter, 'POST', {kind: 'pos-sale-report', params})).json();
    assert.equal(row.counterNo, 2);
    assert.equal((await call('/approvals', counter)).status, 403);
    assert.equal((await call('/approvals/' + row.id, {...counter, session_id: 'other'})).status, 404);
    assert.equal((await call('/approvals/' + row.id, {role: 'ADMIN'}, 'POST', {approved: true})).status, 403);
    const approver = {role: 'SERVER', username: 'server'};
    assert.equal((await (await call('/approvals', approver)).json()).length, 1);
    assert.equal((await call('/approvals/' + row.id, approver, 'POST', {approved: true})).status, 200);
    const result = await call('/pos-sale-report?' + new URLSearchParams(params), counter, 'GET', null, row.id);
    assert.equal(result.status, 200);
    assert.equal((await result.json()).counter, 'Counter 2');
    assert.ok(queries.some(q => q.params?.some(p => String(p).includes('Counter[[:space:]]*2'))));
    assert.equal((await call('/pos-sale-report?from=2026-09-13', counter, 'GET', null, row.id)).status, 403);
    assert.equal((await call('/counter-sale-slip?date=2026-09-12', counter, 'GET', null, row.id)).status, 403);
    const slip = await (await call('/approvals', counter, 'POST', {kind: 'counter-sale-slip', params: {date: '2026-09-12'}})).json();
    await call('/approvals/' + slip.id, approver, 'POST', {approved: true});
    const response = await call('/counter-sale-slip?date=2026-09-12', counter, 'GET', null, slip.id);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).allCounters, null);
  } finally { await new Promise(resolve => server.close(resolve)); }
});
