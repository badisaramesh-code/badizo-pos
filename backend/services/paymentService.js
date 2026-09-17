const { moneyToPaise, paiseToMoney, parseCurrency } = require('../utils/money');

function paymentError(message) { return Object.assign(new Error(message), { code: 'INVALID_PAYMENT' }); }

const PAYMENT_MODES = ['Cash', 'UPI', 'Card', 'Mixed'];

function normalizePaymentMode(paymentMode) {
  return PAYMENT_MODES.includes(paymentMode) ? paymentMode : 'Cash';
}

function normalizePaymentSplits(paymentMode, paymentSplits, grandTotal, paymentReference) {
  const mode = normalizePaymentMode(paymentMode);
  const amounts = mode === 'Mixed' ? [grandTotal, paymentSplits?.cash || 0, paymentSplits?.upi || 0, paymentSplits?.card || 0] : [grandTotal];
  if (amounts.some(value => !Number.isFinite(Number(value)) || Number(value) < 0 || Number(value) > 99999999.99)) {
    throw paymentError('Payment amounts must be valid non-negative amounts.');
  }
  const totalPaise = moneyToPaise(grandTotal);
  const total = paiseToMoney(totalPaise);

  if (mode !== 'Mixed') {
    return [{
      payment_mode: mode,
      amount: total,
      payment_reference: mode === 'Cash' ? null : paymentReference || null
    }].filter((row) => row.amount > 0);
  }

  const source = paymentSplits && typeof paymentSplits === 'object' ? paymentSplits : {};
  const rows = [
    { payment_mode: 'Cash', amount: parseCurrency(source.cash), payment_reference: null },
    { payment_mode: 'UPI', amount: parseCurrency(source.upi), payment_reference: source.upi_reference || source.reference || paymentReference || null },
    { payment_mode: 'Card', amount: parseCurrency(source.card), payment_reference: source.card_reference || source.reference || paymentReference || null }
  ].filter((row) => row.amount > 0);

  if (rows.length < 2) {
    throw paymentError('Enter amounts in any two payment modes for Mixed payment.');
  }

  const paidPaise = rows.reduce((sum, row) => sum + moneyToPaise(row.amount), 0);
  if (paidPaise < totalPaise) {
    throw paymentError('Mixed payment total must be equal to or greater than bill amount.');
  }

  const excessPaise = paidPaise - totalPaise;
  if (excessPaise > 0) {
    const cashRow = rows.find((row) => row.payment_mode === 'Cash' && row.amount > 0);
    if (!cashRow || moneyToPaise(cashRow.amount) < excessPaise) {
      throw paymentError('UPI and Card total cannot exceed the bill amount. Correct the payment amounts.');
    }
    cashRow.amount = paiseToMoney(moneyToPaise(cashRow.amount) - excessPaise);
  }

  return rows.filter((row) => row.amount > 0);
}

function calculatePaymentSettlement(paymentMode, paymentSplits, grandTotal, cashReceived, paymentReference) {
  const mode = normalizePaymentMode(paymentMode);
  const payments = normalizePaymentSplits(mode, paymentSplits, grandTotal, paymentReference);
  const tenderPaise = mode === 'Cash' ? moneyToPaise(cashReceived)
    : mode === 'Mixed' ? ['cash', 'upi', 'card'].reduce((sum, key) => sum + moneyToPaise(paymentSplits?.[key]), 0)
      : moneyToPaise(grandTotal);
  if (mode === 'Cash' && (!Number.isFinite(Number(cashReceived)) || Number(cashReceived) < 0)) {
    throw paymentError('Cash received must be a valid non-negative amount.');
  }
  if (!Number.isFinite(tenderPaise) || tenderPaise > 9999999999) throw paymentError('Payment amount is too large.');
  if (tenderPaise < moneyToPaise(grandTotal)) throw paymentError('Cash received must be equal to or greater than the bill total.');
  return { payments, cashReceived: paiseToMoney(tenderPaise), changeReturned: paiseToMoney(tenderPaise - moneyToPaise(grandTotal)) };
}

module.exports = {
  calculatePaymentSettlement,
  normalizePaymentMode,
  normalizePaymentSplits
};
