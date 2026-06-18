const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizePaymentMode, normalizePaymentSplits } = require('../services/paymentService');

test('normalizePaymentMode falls back to Cash for unknown modes', () => {
  assert.equal(normalizePaymentMode('Cash'), 'Cash');
  assert.equal(normalizePaymentMode('UPI'), 'UPI');
  assert.equal(normalizePaymentMode('bad-value'), 'Cash');
});

test('single payment mode creates one paid row for the bill total', () => {
  assert.deepEqual(normalizePaymentSplits('Card', null, '125.50', 'AUTH-1'), [{
    payment_mode: 'Card',
    amount: 125.5,
    payment_reference: 'AUTH-1'
  }]);
});

test('mixed payment requires at least two modes', () => {
  assert.throws(
    () => normalizePaymentSplits('Mixed', { cash: 100 }, 100),
    /any two payment modes/
  );
});

test('mixed payment rejects short payment totals', () => {
  assert.throws(
    () => normalizePaymentSplits('Mixed', { cash: 50, upi: 25 }, 100),
    /equal to or greater/
  );
});

test('mixed payment trims overpayment from cash first', () => {
  assert.deepEqual(normalizePaymentSplits('Mixed', { cash: 70, upi: 40 }, 100, 'UPI-1'), [
    { payment_mode: 'Cash', amount: 60, payment_reference: null },
    { payment_mode: 'UPI', amount: 40, payment_reference: 'UPI-1' }
  ]);
});
