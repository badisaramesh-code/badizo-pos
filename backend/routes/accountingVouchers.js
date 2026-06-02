const express = require('express');
const router = express.Router();
const db = require('../config/db');
const { authenticate, authorize } = require('../middleware/auth');
const { normalizeDate, parseMoney } = require('../utils/formatters');

function voucherNo(prefix) {
  const now = new Date();
  const stamp = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0'),
    String(now.getHours()).padStart(2, '0'),
    String(now.getMinutes()).padStart(2, '0'),
    String(now.getSeconds()).padStart(2, '0')
  ].join('');
  return `${prefix}-${stamp}`;
}

router.use(authenticate, authorize('SERVER', 'ADMIN'));

router.post('/', async (req, res) => {
  const voucherType = req.body?.voucher_type === 'DEBTOR_RECEIPT' ? 'DEBTOR_RECEIPT' : 'CREDITOR_PAYMENT';
  const paymentMode = req.body?.payment_mode === 'Bank' ? 'Bank' : 'Cash';
  const accountName = String(req.body?.account_name || '').trim();
  const amount = parseMoney(req.body?.amount);
  const voucherDate = normalizeDate(req.body?.voucher_date);
  const prefix = voucherType === 'DEBTOR_RECEIPT' ? 'DRV' : 'CPV';

  if (!accountName) {
    return res.status(400).json({ error: 'Account name is required.' });
  }
  if (amount <= 0) {
    return res.status(400).json({ error: 'Amount must be greater than zero.' });
  }

  try {
    const finalVoucherNo = voucherNo(prefix);
    await db.query(
      `INSERT INTO accounting_vouchers
       (voucher_no, voucher_date, voucher_type, account_name, payment_mode, amount, reference_no, remarks, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        finalVoucherNo,
        voucherDate,
        voucherType,
        accountName,
        paymentMode,
        amount,
        String(req.body?.reference_no || '').trim(),
        String(req.body?.remarks || '').trim(),
        req.user.username
      ]
    );

    res.json({ success: true, voucher_no: finalVoucherNo, voucher_type: voucherType, account_name: accountName, payment_mode: paymentMode, amount, voucher_date: voucherDate });
  } catch (err) {
    console.error('Accounting voucher save failed:', err.message);
    res.status(500).json({ error: 'Unable to save accounting voucher.' });
  }
});

module.exports = router;
