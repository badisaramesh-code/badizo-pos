'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const jwt = require('jsonwebtoken');
const { currentRecoveryActivation, checkCheckoutScope } = require('../services/recoverySessionScope');
const { invoiceEpochForOperation } = require('../services/recoveryInvoiceNumbers');

test('ordinary installations keep existing login and checkout behavior', () => {
  assert.equal(currentRecoveryActivation({}), null);
  assert.doesNotThrow(() => checkCheckoutScope({}, {}));
});
test('old sessions and pending checkout payloads cannot replay across a recovered database', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'badizo-session-scope-'));
  const id = crypto.randomUUID(), epoch = invoiceEpochForOperation(id), file = path.join(root, 'binding.json');
  const binding = { schemaVersion: 1, shopId: 'HFM001', activationId: id, generation: 1, phase: 'active', billingMode: 'active', invoiceEpoch: epoch,
    database: { host: '127.0.0.1', port: 3307, user: 'fixture', password: 'fixture', database: 'badizo_recovery_12345678' } };
  await fs.writeFile(file, JSON.stringify(binding));
  const env = { BADIZO_RUNTIME_BINDING: file, BADIZO_SHOP_ID: 'HFM001', BADIZO_RECOVERY_INVOICE_EPOCH: epoch };
  const old = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]])); Object.assign(process.env, env);
  t.after(async () => { for (const key of Object.keys(env)) { if (old[key] === undefined) delete process.env[key]; else process.env[key] = old[key]; } await fs.rm(root, { recursive: true, force: true }); });
  assert.equal(currentRecoveryActivation(env), id);
  assert.throws(() => checkCheckoutScope({}, env), error => error.code === 'RECOVERY_CHECKOUT_REVIEW_REQUIRED');
  assert.doesNotThrow(() => checkCheckoutScope({ recovery_activation_id: id }, env));
  const { authenticate, JWT_SECRET } = require('../middleware/auth');
  const request = claims => { const res = { status(code) { this.code = code; return this; }, json(value) { this.body = value; return this; } };
    authenticate({ headers: { authorization: 'Bearer ' + jwt.sign(claims, JWT_SECRET) } }, res, () => { res.allowed = true; }); return res; };
  assert.equal(request({ username: 'counter1', role: 'COUNTER' }).body.code, 'RECOVERY_SESSION_CHANGED');
  assert.equal(request({ username: 'counter1', role: 'COUNTER', recovery_activation_id: id }).allowed, true);
  const runtime = require('../services/recoveryRuntimeBinding'); const loadedEnv = { ...env };
  runtime.load(loadedEnv); assert.equal(loadedEnv.DB_PORT, '3307');
});
