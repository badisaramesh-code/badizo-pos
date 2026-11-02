const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const jwt = require('jsonwebtoken');
const { JWT_SECRET } = require('../middleware/auth');
let queries = [];
require.cache[require.resolve('../config/db')] = { exports: { query: async (sql, params) => { queries.push({sql, params}); return [[]]; } } };
const router = require('../routes/reports');
test('HTTP approval flow blocks data before OK and enforces approved report scope and request ownership', async () => {
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
    assert.ok((await (await call('/approvals', approver)).json()).some(request => request.id === row.id));
    assert.equal((await call('/approvals/' + row.id, approver, 'POST', {approved: true})).status, 200);
    const result = await call('/pos-sale-report?' + new URLSearchParams(params), counter, 'GET', null, row.id);
    assert.equal(result.status, 200);
    assert.equal((await result.json()).counter, 'Counter 6');
    assert.equal((await call('/pos-sale-report?' + new URLSearchParams({...params, counter_no: ''}), counter, 'GET', null, row.id)).status, 403);
    const allParams = {...params, counter_no: ''};
    const allRequest = await (await call('/approvals', counter, 'POST', {kind: 'pos-sale-report', params: allParams})).json();
    assert.equal(allRequest.reportCounterNo, 0);
    assert.equal(allRequest.counterNo, 2);
    await call('/approvals/' + allRequest.id, approver, 'POST', {approved: true});
    queries = [];
    const allResponse = await call('/pos-sale-report?' + new URLSearchParams(allParams), counter, 'GET', null, allRequest.id);
    assert.equal(allResponse.status, 200);
    assert.equal((await allResponse.json()).counter, 'ALL');
    assert.ok(queries.length > 0);
    assert.ok(queries.every(q => !q.sql.includes('billing_counter REGEXP')));
    assert.equal((await call('/pos-sale-report?' + new URLSearchParams(params), counter, 'GET', null, allRequest.id)).status, 403);
    // GST reports support both all counters and an individually approved counter.
    for (const scope of ['', '2']) {
      const gstParams = {...params, counter_no: scope, report_type: 'GST'};
      const request = await (await call('/approvals', counter, 'POST', {kind: 'pos-sale-report', params: gstParams})).json();
      assert.equal(request.reportType, 'GST');
      assert.equal(request.reportCounterNo, scope ? 2 : 0);
      assert.equal((await call('/pos-sale-report?' + new URLSearchParams(gstParams), counter, 'GET', null, request.id)).status, 403);
      await call('/approvals/' + request.id, approver, 'POST', {approved: true});
      queries = [];
      const response = await call('/pos-sale-report?' + new URLSearchParams(gstParams), counter, 'GET', null, request.id);
      assert.equal(response.status, 200);
      const report = await response.json();
      assert.equal(report.reportType, 'GST');
      assert.equal(report.counter, scope ? 'Counter 2' : 'ALL');
      assert.ok(Array.isArray(report.gst));
      const gstQuery = queries.find(q => q.sql.includes('GROUP BY ii.gst_percent'));
      assert.ok(gstQuery);
      assert.equal(gstQuery.sql.includes('billing_counter REGEXP'), Boolean(scope));
      if (scope) assert.ok(gstQuery.params.some(p => String(p).includes('Counter[[:space:]]*2')));
      assert.equal((await call('/pos-sale-report?' + new URLSearchParams({...gstParams, report_type: 'ALL'}), counter, 'GET', null, request.id)).status, 403);
    }
    // Old clients do not send an approval header or a POST request.
    const legacyUser = {...counter, session_id: 'legacy-client'};
    const legacyResponse = await call('/pos-sale-report?' + new URLSearchParams(params), legacyUser);
    assert.equal(legacyResponse.status, 403);
    const legacyRequest = await legacyResponse.json();
    assert.ok(legacyRequest.requestId);
    assert.ok((await (await call('/approvals', approver)).json()).some(request => request.id === legacyRequest.requestId));
    await call('/approvals/' + legacyRequest.requestId, approver, 'POST', {approved: true});
    const legacyRetry = await call('/pos-sale-report?' + new URLSearchParams(params), legacyUser);
    assert.equal(legacyRetry.status, 200);
    assert.equal((await legacyRetry.json()).counter, 'Counter 6');
    assert.equal((await call('/pos-sale-report?from=2026-09-13', legacyUser)).status, 403);
    assert.ok(queries.some(q => q.params?.some(p => String(p).includes('Counter[[:space:]]*6'))));
    assert.equal((await call('/pos-sale-report?from=2026-09-13', counter, 'GET', null, row.id)).status, 403);
    assert.equal((await call('/counter-sale-slip?date=2026-09-12', counter, 'GET', null, row.id)).status, 403);
    const slip = await (await call('/approvals', counter, 'POST', {kind: 'counter-sale-slip', params: {date: '2026-09-12'}})).json();
    await call('/approvals/' + slip.id, approver, 'POST', {approved: true});
    const response = await call('/counter-sale-slip?date=2026-09-12', counter, 'GET', null, slip.id);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).allCounters, null);
  } finally { await new Promise(resolve => server.close(resolve)); }
});
