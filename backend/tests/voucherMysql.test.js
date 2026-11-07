const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const mysql = require('mysql2/promise');
const express = require('express');
const jwt = require('jsonwebtoken');
const { JWT_SECRET } = require('../middleware/auth');

// Explicit opt-in. Connect only to a local server and create our own empty database.
test('concurrent payments and supplier failure preserve persisted voucher balances', {
  skip: process.env.BADIZO_TEST_VOUCHER_MYSQL !== '1'
}, async t => {
  const credentials = {
    host: '127.0.0.1',
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || ''
  };
  const admin = await mysql.createConnection(credentials);
  const database = 'qa_voucher_' + randomBytes(12).toString('hex');
  let created = false;
  let pool;
  let server;
  t.after(async () => {
    try {
      if (server) await new Promise(resolve => server.close(resolve));
      if (pool) await pool.end();
      if (created) await admin.query('DROP DATABASE ' + database);
    } finally {
      await admin.end();
    }
  });
  await admin.query('CREATE DATABASE ' + database);
  created = true;
  pool = mysql.createPool({ ...credentials, database, connectionLimit: 12 });
  const schema = fs.readFileSync(path.join(__dirname, '../config/db.js'), 'utf8');
  for (const table of ['accounting_vouchers', 'suppliers']) {
    const start = schema.indexOf('CREATE TABLE IF NOT EXISTS ' + table + ' (');
    assert.ok(start >= 0, 'Missing fixture schema for ' + table);
    await pool.query(schema.slice(start, schema.indexOf(';', start)));
  }

  require.cache[require.resolve('../config/db')] = { exports: pool };
  const app = express();
  app.use(express.json());
  app.use('/vouchers', require('../routes/accountingVouchers'));
  server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const token = jwt.sign({ username: 'qa', role: 'ADMIN' }, JWT_SECRET);
  const post = body => fetch('http://127.0.0.1:' + server.address().port + '/vouchers', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
    body: JSON.stringify(body)
  });

  const expense = { account_name: 'QA supplier', amount: 5, voucher_date: '2026-11-07', voucher_type: 'EXPENSE' };
  const creditor = { ...expense, voucher_type: 'CREDITOR_PAYMENT', bank_name: 'QA bank' };
  for (const body of [expense, creditor]) {
    const results = await Promise.all(Array.from({ length: 20 }, () => post(body)));
    assert.ok(results.every(response => response.ok), 'Concurrent ' + body.voucher_type + ' payments must all save');
  }
  await pool.query("CREATE TRIGGER fail_update BEFORE UPDATE ON suppliers FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='Deliberate QA failure'");
  assert.equal((await post({ ...creditor, bank_name: 'Should roll back' })).status, 500);
  const [vouchers] = await pool.query('SELECT COUNT(*) AS total, COUNT(DISTINCT voucher_no) AS distinct_numbers, SUM(amount) AS amount FROM accounting_vouchers');
  assert.equal(vouchers[0].total, 40);
  assert.equal(vouchers[0].distinct_numbers, 40);
  assert.equal(Number(vouchers[0].amount), 200);
  const [suppliers] = await pool.query('SELECT bank_name FROM suppliers');
  assert.equal(suppliers.length, 1);
  assert.equal(suppliers[0].bank_name, 'QA bank');
});
