'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { invoiceEpochForOperation, validInvoiceEpoch, recoveryInvoicePrefix, prepareRecoveryInvoiceNumbers } = require('../services/recoveryInvoiceNumbers');
const { invoicePrefix } = require('../services/runtimePolicy');
const operationId = '12345678-1234-4234-8234-123456789abc';
function candidate(name = 'badizo_recovery_12345678') {
  const writes = [];
  return { writes, beginTransaction: async () => writes.push('begin'), commit: async () => writes.push('commit'), rollback: async () => writes.push('rollback'),
    query: async (sql, args) => {
      if (sql.startsWith('SELECT DATABASE')) return [[{ database_name: name }]];
      if (sql.includes('information_schema')) return [[...['invoices', 'invoice_items', 'invoice_payments'].map(table_name => ({ table_name, width: 50 }))]];
      if (sql.startsWith('SELECT invoice_no') || sql.startsWith('SELECT financial_year')) return [[]];
      writes.push({ sql, args }); return [[]];
    } };
}
test('recovery namespace preserves every operation UUID bit, remains case-insensitive safe, and is stable on retry', () => {
  const value = invoiceEpochForOperation(operationId);
  assert.equal(value.length, 26); assert.equal(validInvoiceEpoch(value), true);
  assert.equal(invoiceEpochForOperation(operationId), value);
  assert.notEqual(invoiceEpochForOperation('12345678-1234-4234-8234-123456789abd'), value);
  assert.equal(invoicePrefix({}), 'BZ'); assert.equal(invoicePrefix({ BADIZO_NODE_ROLE: 'cloud-active' }), 'CL');
  assert.equal(invoicePrefix({ BADIZO_RECOVERY_INVOICE_EPOCH: value }), 'BZ' + value);
  assert.equal(recoveryInvoicePrefix('cloud-standby', value), 'CL' + value);
  assert.ok(('BZ' + value + '/2026-27/C99/999999999').length <= 50);
  assert.throws(() => invoiceEpochForOperation('../path'));
  assert.throws(() => recoveryInvoicePrefix('local-server', 'invalid'));
});
test('candidate-only preparation does not need lost source high-water to prevent number reuse', async () => {
  const db = candidate();
  const result = await prepareRecoveryInvoiceNumbers({ candidateConnection: db, nodeRole: 'local-server', operationId });
  assert.equal(result.invoiceNumbersVerified, true); assert.equal(result.previousHighWaterPreserved, false);
  assert.equal(db.writes.some(row => row.sql), false);
});
test('known previous high-water is preserved only inside the candidate', async () => {
  const db = candidate(); const previous = { query: async sql => sql.includes('DATABASE()') ? [[{ database_name: 'previous_pos' }]] : [[{ financial_year: '2026-27', next_number: 90000 }]] };
  const result = await prepareRecoveryInvoiceNumbers({ candidateConnection: db, previousConnection: previous, nodeRole: 'cloud-standby', operationId });
  assert.equal(result.previousHighWaterPreserved, true);
  assert.deepEqual(db.writes[1].args, ['2026-27', 90000]);
});

test('the existing shop two-digit financial year is preserved during recovery', async () => {
  const db = candidate(); const original = db.query;
  db.query = (sql,args) => sql.startsWith('SELECT financial_year') ? [[{financial_year:'26-27',next_number:145316}]] : original(sql,args);
  const result = await prepareRecoveryInvoiceNumbers({candidateConnection:db,nodeRole:'local-server',operationId});
  assert.equal(result.invoiceNumbersVerified,true);
});
test('active database and a namespace that already accepted bills are rejected', async () => {
  await assert.rejects(prepareRecoveryInvoiceNumbers({ candidateConnection: candidate('badizo_pos'), nodeRole: 'local-server', operationId }), /isolated/);
  const db = candidate(); const original = db.query; db.query = (sql, args) => sql.startsWith('SELECT invoice_no') ? [[{ invoice_no: 'already-sold' }]] : original(sql, args);
  await assert.rejects(prepareRecoveryInvoiceNumbers({ candidateConnection: db, nodeRole: 'local-server', operationId }), /already accepted bills/);
});

test('candidate and previous high-water reject billion-length overflow before transactions', async () => {
  for (const value of [1000000000, 1000000001]) {
    for (const source of ['candidate', 'previous']) {
      const db = candidate(); const original = db.query;
      const rows = [{financial_year:'2026-27',next_number:value}];
      if (source === 'candidate') db.query = (sql,args) => sql.startsWith('SELECT financial_year') ? [rows] : original(sql,args);
      const previousConnection = source === 'previous' ? {query:async sql => sql.includes('DATABASE()') ? [[{database_name:'previous_pos'}]] : [rows]} : null;
      await assert.rejects(prepareRecoveryInvoiceNumbers({candidateConnection:db,previousConnection,nodeRole:'local-server',operationId}), /supported recovery number length/);
      assert.equal(db.writes.length, 0);
    }
  }
});
