const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { isCloudNode, bindHost, cloudWriteGuard, invoicePrefix } = require('../services/runtimePolicy');

test('local binding and invoice prefixes keep their existing defaults', () => {
  assert.equal(isCloudNode({}), false);
  assert.equal(bindHost(undefined, {}), '0.0.0.0');
  assert.equal(bindHost('127.0.0.1', {}), '0.0.0.0');
  assert.equal(bindHost('192.168.1.10', {}), '192.168.1.10');
  assert.equal(invoicePrefix({}), 'BZ');
});
test('cloud binds privately and uses a separate invoice prefix', () => {
  const env = { BADIZO_NODE_ROLE: 'cloud-standby' };
  assert.equal(isCloudNode(env), true);
  assert.equal(bindHost(undefined, env), '127.0.0.1');
  assert.equal(bindHost('localhost', env), '127.0.0.1');
  assert.throws(() => bindHost('0.0.0.0', env));
  assert.equal(invoicePrefix(env), 'CL');
});
test('standby blocks billing writes while permitting login and reads; local behavior is unchanged', async t => {
  const original = process.env.BADIZO_NODE_ROLE;
  t.after(() => { if (original === undefined) delete process.env.BADIZO_NODE_ROLE; else process.env.BADIZO_NODE_ROLE = original; });
  const app = express(); app.use('/api', cloudWriteGuard); app.use((_req, res) => res.json({ ok: true }));
  const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}/api`;
  process.env.BADIZO_NODE_ROLE = 'cloud-standby';
  assert.equal((await fetch(`${base}/billing/checkout`, { method: 'POST' })).status, 409);
  assert.equal((await fetch(`${base}/settings`, { method: 'POST' })).status, 409);
  assert.equal((await fetch(`${base}/auth/login`, { method: 'POST' })).status, 200);
  assert.equal((await fetch(`${base}/products`)).status, 200);
  process.env.BADIZO_NODE_ROLE = 'cloud-active';
  assert.equal((await fetch(`${base}/billing/checkout`, { method: 'POST' })).status, 200);
  delete process.env.BADIZO_NODE_ROLE;
  assert.equal((await fetch(`${base}/billing/checkout`, { method: 'POST' })).status, 200);
});
