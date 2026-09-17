const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const jwt = require('jsonwebtoken');
let state;
function mock(modulePath, exports) { require.cache[require.resolve(modulePath)] = { exports }; }
mock('../services/logger', { logError() {}, logInfo() {} });
mock('../config/db', { getConnection: async () => {
  if (state.connectionError) throw Object.assign(new Error('private database details'), { code: 'ECONNREFUSED' });
  return {
    async beginTransaction() { state.begun = true; },
    async commit() { state.committed = true; },
    async rollback() { if (state.rollbackError) throw Object.assign(new Error('rollback failed'), { code: 'ECONNRESET' }); state.rolledBack = true; },
    release() { state.released = true; },
    async query(sql, params) {
      state.queries.push({ sql, params });
      if (sql.includes('FROM invoices') && sql.includes('checkout_request_id')) return [state.existing ? [state.existing] : []];
      if (sql.includes('FROM invoice_items')) return [state.savedItems || [{ barcode: 'PRODUCT1', quantity: 1, sale_price: 100, is_free_bonus: 0 }]];
      if (sql.includes('FROM products WHERE barcode IN')) return [[{ barcode: 'PRODUCT1', product_name: 'Test product', sale_price: 100 }]];
      if (sql.includes('INSERT INTO invoices')) state.invoiceParams = params;
      if (/^\s*(SELECT|SET)/.test(sql)) return [[]];
      return [{ affectedRows: 1, insertId: 1 }];
    }
  };
} });
mock('../services/invoiceNumberService', {
  allocateInvoiceNo: async () => ({ invoiceNo: 'BZ/26-27/C01/000001', financialYear: '26-27', sequenceNo: 1 }),
  getCounterCount: async () => 6, normalizeCounterNo: value => Number(value) || 1,
  ensureSequenceRow: async () => {}, formatInvoiceNo: () => '', getFinancialYear: () => '26-27'
});
mock('../services/auditService', { writeAuditLog: async () => {} });
mock('../services/smsService', { sendBillSms: async () => ({ skipped: true }) });
mock('../services/whatsappService', { sendBillWhatsApp: async () => ({ skipped: true }) });
const { JWT_SECRET } = require('../middleware/auth');
const { protectAsyncRoutes, apiErrorHandler } = require('../middleware/asyncRoutes');
const router = require('../routes/billing');

test('billing HTTP reliability with an isolated database double', async t => {
  const app = express();
  app.use(express.json());
  app.use('/billing', protectAsyncRoutes(router));
  app.get('/health', (_req, res) => res.json({ ok: true }));
  app.use(apiErrorHandler);
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = 'http://127.0.0.1:' + server.address().port;
  const headers = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + jwt.sign({ role: 'COUNTER', username: 'counter1', counter_no: 1 }, JWT_SECRET) };
  const payload = { checkout_request_id: 'test-checkout-12345', counter_no: 1, items: [{ barcode: 'PRODUCT1', quantity: 1, sale_price: 100, gst_percent: 0 }], grand_total: 100, sub_total: 100, payment_mode: 'Cash', cash_received: 150, change_returned: 999 };
  const post = body => fetch(base + '/billing/checkout', { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(2000) });
  function reset(extra = {}) { state = { queries: [], ...extra }; }
  await t.test('cash sale commits the calculated change, not client-supplied change', async () => {
    reset(); const response = await post(payload);
    assert.equal(response.status, 200); assert.equal(state.committed, true); assert.equal(state.released, true);
    assert.equal(state.invoiceParams[10], 150); assert.equal(state.invoiceParams[11], 50);
  });
  await t.test('price changes return a clear conflict and roll back without saving', async () => {
    reset(); const response = await post({ ...payload, items: [{ ...payload.items[0], sale_price: 90 }] });
    assert.equal(response.status, 409); assert.equal((await response.json()).code, 'PRICE_CHANGED');
    assert.equal(state.rolledBack, true); assert.equal(state.committed, undefined); assert.equal(state.invoiceParams, undefined);
  });
  await t.test('zero quantity cannot silently turn into one sold item', async () => {
    reset(); const response = await post({ ...payload, items: [{ ...payload.items[0], quantity: 0 }] });
    assert.equal(response.status, 400); assert.equal(state.rolledBack, true); assert.equal(state.committed, undefined);
    assert.ok(!state.queries.some(query => query.sql.includes('UPDATE products')));
  });
  await t.test('a database connection failure returns JSON and the server stays available', async () => {
    reset({ connectionError: true }); const response = await post(payload);
    assert.equal(response.status, 503); const body = await response.json();
    assert.equal(body.code, 'DATABASE_UNAVAILABLE'); assert.ok(!JSON.stringify(body).includes('private database'));
    assert.equal((await fetch(base + '/health')).status, 200);
  });
  await t.test('a rollback connection failure is contained and the connection released', async () => {
    reset({ rollbackError: true }); const response = await post({ ...payload, items: [{ ...payload.items[0], sale_price: 90 }] });
    assert.equal(response.status, 503); assert.equal(state.released, true);
  });
  await t.test('retry of an already saved ID does not write stock or a second invoice', async () => {
    reset({ existing: { invoice_no: 'BZ/26-27/C01/000001', grand_total: 100, invoice_status: 'PAID', billing_counter: 'Counter1' } });
    const response = await post(payload); assert.equal(response.status, 200);
    assert.equal((await response.json()).duplicate_prevented, true);
    assert.equal(state.begun, undefined); assert.equal(state.invoiceParams, undefined);
  });
  await t.test('saved retries retain free items and reject a changed cart with the same total', async () => {
    const existing = { invoice_no: 'BZ/26-27/C01/000001', grand_total: 100, invoice_status: 'PAID' };
    const bonus = { barcode: 'FREE1', product_name: 'Free gift', quantity: 1, sale_price: 0, is_free_bonus: 1 };
    reset({ existing, savedItems: [{ ...payload.items[0], is_free_bonus: 0 }, bonus] });
    const response = await post(payload); assert.equal(response.status, 200);
    assert.deepEqual((await response.json()).free_items, [bonus]);
    reset({ existing, savedItems: [{ ...payload.items[0], quantity: 0.33, is_free_bonus: 0 }] });
    assert.equal((await post({ ...payload, items: [{ ...payload.items[0], quantity: 0.333 }] })).status, 200);
    reset({ existing });
    const changed = await post({ ...payload, items: [{ ...payload.items[0], barcode: 'OTHER' }] });
    assert.equal(changed.status, 409); assert.equal(state.begun, undefined);
    reset({ existing: { ...existing, invoice_status: 'CANCELLED' } });
    assert.equal((await post(payload)).status, 409);
  });
  await t.test('digital overpayment cannot be committed', async () => {
    reset(); const response = await post({ ...payload, payment_mode: 'Mixed', payment_splits: { cash: 10, upi: 200, card: 200 } });
    assert.equal(response.status, 400); assert.equal(state.rolledBack, true); assert.equal(state.invoiceParams, undefined);
  });
  await t.test('malformed requests return JSON instead of a hanging request', async () => {
    const response = await fetch(base + '/billing/checkout', { method: 'POST', headers, body: '{', signal: AbortSignal.timeout(2000) });
    assert.equal(response.status, 400); assert.equal((await response.json()).code, 'INVALID_JSON');
  });
});
