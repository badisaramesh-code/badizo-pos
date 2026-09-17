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

const { calculatePaymentSettlement } = require('../services/paymentService');

test('rejects digital overpayment instead of saving an incorrect split or hiding excess', () => {
  for (const split of [{ cash: 10, upi: 200, card: 200 }, { upi: 70, card: 50 }]) {
    assert.throws(() => normalizePaymentSplits('Mixed', split, 100), /cannot exceed/);
  }
});

test('cash change and mixed tender are calculated on the server', () => {
  assert.deepEqual(calculatePaymentSettlement('Cash', null, 100, 150), {
    payments: [{ payment_mode: 'Cash', amount: 100, payment_reference: null }], cashReceived: 150, changeReturned: 50
  });
  const mixed = calculatePaymentSettlement('Mixed', { cash: 70, upi: 40 }, 100, 999);
  assert.equal(mixed.cashReceived, 110);
  assert.equal(mixed.changeReturned, 10);
  assert.equal(mixed.payments.reduce((sum, row) => sum + row.amount, 0), 100);
});

test('rejects negative and non-finite payment amounts', () => {
  for (const value of [-1, Infinity, 'invalid']) {
    assert.throws(() => normalizePaymentSplits('Mixed', { cash: value, upi: 100 }, 100), /valid non-negative/);
    assert.throws(() => calculatePaymentSettlement('Cash', null, 100, value), /valid non-negative/);
  }
});

test('valid mixed settlements always balance including paise and all-cash change', () => {
  for (const [total, cash, upi, card] of [[100, 70, 40, 0], [100, 10, 100, 0], [100, 0, 70, 30], [100.25, 50.5, 30.25, 30]]) {
    const result = calculatePaymentSettlement('Mixed', { cash, upi, card }, total, 0);
    assert.equal(result.payments.reduce((sum, row) => sum + Math.round(row.amount * 100), 0), Math.round(total * 100));
    assert.equal(Math.round((result.cashReceived - result.changeReturned) * 100), Math.round(total * 100));
  }
});
