const test = require('node:test');
const assert = require('node:assert/strict');
const { buildCounterLabels, applyCounterLabel } = require('../utils/bookCounterLabels');

test('counter labels keep latest matching invoice per date and exact counter number', () => {
  const labels = buildCounterLabels([
    { invoice_date: '2026-09-07', billing_counter: 'OLD/Counter1', latest_at: '2026-09-07T10:00:00' },
    { invoice_date: '2026-09-07', billing_counter: 'ADMIN/Counter1', latest_at: '2026-09-07T12:00:00' },
    { invoice_date: '2026-09-07', billing_counter: 'OTHER/Counter11', latest_at: '2026-09-07T13:00:00' },
    { invoice_date: '2026-09-07', billing_counter: 'OTHER/Counter01', latest_at: '2026-09-07T14:00:00' },
    { invoice_date: '2026-09-08', billing_counter: 'NEXT/Counter1', latest_at: '2026-09-08T14:00:00' }
  ]);
  const row = { counter_no: 1, counter_label: 'C1', amount: 123 };
  applyCounterLabel(labels, row, '2026-09-07');
  assert.deepEqual(row, { counter_no: 1, counter_label: 'ADMIN/C1', amount: 123 });
  const localDateRow = { counter_no: 1, counter_label: 'C1' };
  applyCounterLabel(labels, localDateRow, new Date(2026, 8, 7));
  assert.equal(localDateRow.counter_label, 'ADMIN/C1');
  const missing = { counter_no: 2, counter_label: 'C2' };
  applyCounterLabel(labels, missing, '2026-09-07');
  assert.equal(missing.counter_label, 'C2');
});
