const { moneyToPaise, paiseToMoney, parseCurrency } = require('../utils/money');

const PAYMENT_MODES = ['Cash', 'UPI', 'Card', 'Mixed'];

function normalizePaymentMode(paymentMode) {
  return PAYMENT_MODES.includes(paymentMode) ? paymentMode : 'Cash';
}

function normalizePaymentSplits(paymentMode, paymentSplits, grandTotal, paymentReference) {
  const mode = normalizePaymentMode(paymentMode);
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
    throw new Error('Enter amounts in any two payment modes for Mixed payment.');
  }

  const paidPaise = rows.reduce((sum, row) => sum + moneyToPaise(row.amount), 0);
  if (paidPaise < totalPaise) {
    throw new Error('Mixed payment total must be equal to or greater than bill amount.');
  }

  const excessPaise = paidPaise - totalPaise;
  if (excessPaise > 0) {
    const cashRow = rows.find((row) => row.payment_mode === 'Cash' && row.amount > 0);
    const adjustmentRow = cashRow || rows[rows.length - 1];
    adjustmentRow.amount = paiseToMoney(Math.max(moneyToPaise(adjustmentRow.amount) - excessPaise, 0));
  }

  return rows.filter((row) => row.amount > 0);
}

module.exports = {
  normalizePaymentMode,
  normalizePaymentSplits
};
