const test = require('node:test');
const assert = require('node:assert/strict');
const { lockLedgerSource, syncNamedLedgerDetails } = require('../utils/syncNamedLedgerDetails');
const entry = { id: 7, source_type: 'COUNTER_HANDOVER', source_id: 9, account_name: 'Expense - Bike repair', details: 'CH-20260918-C1 Counter 1', direction: 'DR', amount: '100.00', payment_mode: 'GENERAL' };
const source = { id: 20, sheet_id: 9, details: 'Bike repair', remarks: '', direction: 'DR', amount: '100.00', entry_type: 'GENERAL' };
test('edits only matching closing details and source account; repeated edits remain linked', async () => {
  const writes = [];
  let savedSource = { ...source }, savedEntry = { ...entry };
  const connection = { query: async (sql, params) => {
    if (sql.startsWith('SELECT * FROM counter_handover_entries')) return [[savedSource, { ...source, id: 21, amount: '200.00' }]];
    writes.push({ sql, params });
    if (sql.startsWith('UPDATE counter_handover_entries')) savedSource.details = params[0];
    if (sql.startsWith('UPDATE counter_cash_ledger_entries')) savedEntry.account_name = params[0];
    return [{}];
  } };
  await syncNamedLedgerDetails(connection, savedEntry, 'BSR');
  assert.equal(savedSource.details, 'BSR');
  assert.equal(savedEntry.account_name, 'BSR');
  assert.deepEqual(writes[0].params, ['BSR', 20]);
  assert.ok(writes.every(write => !/SET.*(amount|direction)/.test(write.sql)));
  await syncNamedLedgerDetails(connection, savedEntry, 'Updated text');
  assert.equal(savedSource.details, 'Updated text');
  assert.equal(savedEntry.account_name, 'UPDATED TEXT');
});
test('missing or ambiguous source lines and overlong text cannot change a closing sheet', async () => {
  for (const sources of [[], [source, { ...source, id: 21 }]]) {
    const connection = { query: async sql => { assert.ok(sql.startsWith('SELECT')); return [sources]; } };
    await assert.rejects(syncNamedLedgerDetails(connection, entry, 'BSR'), { status: 409 });
  }
  await assert.rejects(syncNamedLedgerDetails({ query: () => assert.fail('No writes allowed') }, entry, 'x'.repeat(181)), { status: 400 });
  await syncNamedLedgerDetails({ query: () => assert.fail('Manual entries have no closing sheet') }, { source_type: 'NAMED_LEDGER_MANUAL' }, 'BSR');
});
test('sheet lock precedes ledger lock to serialize with closing saves', async () => {
  const calls = [];
  const connection = { query: async sql => { calls.push(sql); return [[entry]]; } };
  assert.equal(await lockLedgerSource(connection, 7), entry);
  assert.match(calls[1], /counter_handover_sheets.*FOR UPDATE/);
  assert.match(calls[2], /counter_cash_ledger_entries.*FOR UPDATE/);
});
