const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const jwt = require('jsonwebtoken');
const { JWT_SECRET } = require('../middleware/auth');

let answer, calls, audits, committed, transactionEvents;
const mock = (name, exports) => { require.cache[require.resolve(name)] = { exports }; };
async function query(sql, params) {
  calls.push({ sql, params });
  if (!answer) throw Error('Unexpected database call');
  return [await answer(sql, params)];
}
mock('../config/db', {
  query,
  async getConnection() {
    const pending = [];
    return {
      async beginTransaction() { transactionEvents.push('begin'); },
      async query(sql, params) {
        const result = await query(sql, params);
        pending.push({sql, params});
        return result;
      },
      async commit() { committed.push(...pending); transactionEvents.push('commit'); },
      async rollback() { pending.length = 0; transactionEvents.push('rollback'); },
      release() { transactionEvents.push('release'); }
    };
  }
});
mock('../services/auditService', { async writeAuditLog(record) { audits.push(record); } });

test('customer, accounting and user management HTTP regression', async t => {
  const app = express();
  app.use(express.json());
  app.use('/customers', require('../routes/customers'));
  app.use('/vouchers', require('../routes/accountingVouchers'));
  app.use('/users', require('../routes/users'));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const base = 'http://127.0.0.1:' + server.address().port;
  async function request(path, role, body) {
    const headers = { 'content-type': 'application/json' };
    if (role) headers.authorization = 'Bearer ' + jwt.sign({ role, username: 'qa' }, JWT_SECRET);
    const response = await fetch(base + path, { method: body ? 'POST' : 'GET', headers, body: body && JSON.stringify(body) });
    return { status: response.status, data: await response.json() };
  }
  function reset(handler) { calls = []; audits = []; committed = []; transactionEvents = []; answer = handler; }

  await t.test('role restrictions and invalid input reject before writes', async () => {
    reset();
    assert.equal((await request('/customers', null)).status, 401);
    assert.equal((await request('/users', 'COUNTER')).status, 403);
    assert.equal((await request('/vouchers', 'COUNTER', { amount: 2 })).status, 403);
    assert.equal((await request('/customers', 'COUNTER', { phone: '100' })).status, 400);
    assert.equal((await request('/vouchers', 'ADMIN', { amount: 0, account_name: 'Supplier A' })).status, 400);
    assert.equal((await request('/users', 'ADMIN', { username: 'cashier', password: 'tiny' })).status, 400);
    assert.equal(calls.length, 0);
  });

  await t.test('counter customer save normalizes phone without resetting accumulated loyalty', async () => {
    const customer = { id: 3, customer_name: 'Anu', phone: '9000000123', loyalty_points: '7', total_spent: '350.50', visit_count: 4 };
    reset(sql => sql.startsWith('INSERT') ? { affectedRows: 1 } : [customer]);
    const result = await request('/customers', 'COUNTER', { name: ' Anu ', phone: '+91 90000 00123', address: ' Shop Road ' });
    assert.equal(result.status, 200);
    assert.deepEqual(calls[0].params, ['Anu', customer.phone, '', 'Shop Road']);
    assert.doesNotMatch(calls[0].sql, /loyalty_points|total_spent|visit_count/);
    assert.equal(result.data.loyalty_points, 7);
    assert.equal(result.data.total_spent, 350.5);
    assert.equal(audits[0].entityId, customer.phone);
  });

  await t.test('previous bill match uses customer telephone and returns invoice and loyalty details', async () => {
    reset(sql => {
      if (sql.includes('FROM invoices i')) return [{ customer_name: 'Anu', customer_phone: '9000000123', last_invoice_no: 'TEST-4' }];
      if (sql.includes('COUNT(*)')) return [{ billing_count: 4, total_spent: '120.5' }];
      return [{ id: 3, loyalty_points: 12 }];
    });
    const { status, data } = await request('/customers/match?phone=9000000123&name=Another', 'COUNTER');
    assert.equal(status, 200);
    assert.equal(data.last_invoice_no, 'TEST-4');
    assert.equal(data.billing_count, 4);
    assert.equal(data.loyalty_points, 12);
    assert.ok(calls.every(call => call.params[0] === '9000000123'));
    assert.match(calls[0].sql, /invoice_status <> 'CANCELLED'/);
  });

  await t.test('bank creditor payment records voucher and creates previously unknown supplier', async () => {
    reset(sql => sql.startsWith('SELECT id FROM suppliers') ? [] : { affectedRows: 1 });
    const { status, data } = await request('/vouchers', 'ADMIN', { voucher_type: 'CREDITOR_PAYMENT', amount: 62.75,
      account_name: ' Shop Supplies ', bank_ifsc: 'abcd00001', payment_mode: 'Bank', voucher_date: '7/11/2026' });
    assert.equal(status, 200);
    assert.match(data.voucher_no, /^CPV-/);
    assert.equal(data.voucher_date, '2026-11-07');
    assert.equal(data.amount, 62.75);
    assert.deepEqual(calls[0].params.slice(2, 6), ['CREDITOR_PAYMENT', 'Shop Supplies', 'Bank', 62.75]);
    assert.match(calls[2].sql, /INSERT INTO suppliers/);
    assert.ok(calls[2].params.includes('ABCD00001'));
  });

  await t.test('expense voucher does not change supplier details', async () => {
    reset(() => ({ affectedRows: 1 }));
    const result = await request('/vouchers', 'SERVER', { voucher_type: 'EXPENSE', amount: 50, account_name: 'Stationery', bank_name: 'Example' });
    assert.equal(result.status, 200);
    assert.match(result.data.voucher_no, /^EXV-/);
    assert.equal(calls.length, 1);
  });

  await t.test('simultaneous expense submissions receive distinct persisted numbers', async () => {
    reset(() => ({ affectedRows: 1 }));
    const payments = Array.from({length: 20}, () => request('/vouchers', 'ADMIN', {
      voucher_type: 'EXPENSE', amount: 15, account_name: 'Stationery'
    }));
    const results = await Promise.all(payments);
    assert.ok(results.every(result => result.status === 200));
    const numbers = results.map(result => result.data.voucher_no);
    assert.equal(new Set(numbers).size, payments.length);
    assert.deepEqual(committed.map(row => row.params[0]).sort(), numbers.sort());
  });

  await t.test('a supplier write failure cancels the whole payment and releases its connection', async () => {
    reset(sql => {
      if (sql.startsWith('SELECT id FROM suppliers')) return [{ id: 1 }];
      if (sql.startsWith('UPDATE suppliers')) throw Error('simulated supplier failure');
      return { affectedRows: 1 };
    });
    const response = await request('/vouchers', 'ADMIN', {
      amount: 75, account_name: 'Shop Supplies', bank_name: 'Example'
    });
    assert.equal(response.status, 500);
    assert.ok(calls[0].sql.includes('INSERT INTO accounting_vouchers'));
    assert.deepEqual(transactionEvents, ['begin', 'rollback', 'release']);
    assert.equal(committed.length, 0);
  });

  const cashier = { id: 2, username: 'billing2', role: 'COUNTER', counter_no: 2, is_active: 1, password_hash: 'must-remain-private' };
  await t.test('new cashier password is hashed, identity audited, and hashes omitted from response', async () => {
    reset(sql => sql.includes('INSERT INTO users') ? { insertId: 2 } : [cashier]);
    const result = await request('/users', 'SERVER', { username: cashier.username, password: 'test-only-strong', role: cashier.role, counter_no: 2 });
    assert.equal(result.status, 200);
    assert.match(calls[0].params[1], /^[a-f0-9]{32}:[a-f0-9]{128}$/);
    assert.equal(result.data.counter_no, 2);
    assert.equal(result.data.password_hash, undefined);
    assert.equal(audits[0].action, 'USER_CREATED');
    assert.doesNotMatch(JSON.stringify(audits), /test-only-strong/);
  });

  await t.test('disable user without replacing current password', async () => {
    reset(sql => sql.includes('UPDATE users') ? { affectedRows: 1 } : [{ ...cashier, is_active: 0 }]);
    const result = await request('/users', 'SERVER', { id: 2, username: cashier.username, role: cashier.role, is_active: false, counter_no: 2 });
    assert.equal(result.status, 200);
    assert.equal(result.data.is_active, false);
    assert.doesNotMatch(calls[0].sql, /password_hash/);
    assert.equal(audits[0].details.passwordChanged, false);
  });

  await t.test('legacy users table lacking timestamp columns still lists safe public users', async () => {
    reset(sql => {
      if (sql.includes('created_at')) throw Object.assign(Error('legacy schema'), { code: 'ER_BAD_FIELD_ERROR' });
      return [cashier];
    });
    const result = await request('/users', 'ADMIN');
    assert.equal(result.status, 200);
    assert.equal(result.data[0].created_at, null);
    assert.equal(result.data[0].password_hash, undefined);
  });
});
