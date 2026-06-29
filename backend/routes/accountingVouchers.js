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
  const allowedVoucherTypes = new Set(['CREDITOR_PAYMENT', 'DEBTOR_RECEIPT', 'EXPENSE', 'CUSTOMER_CREDIT']);
  const requestedVoucherType = String(req.body?.voucher_type || '').trim().toUpperCase();
  const voucherType = allowedVoucherTypes.has(requestedVoucherType) ? requestedVoucherType : 'CREDITOR_PAYMENT';
  const paymentMode = req.body?.payment_mode === 'Bank' ? 'Bank' : 'Cash';
  const accountName = String(req.body?.account_name || '').trim();
  const amount = parseMoney(req.body?.amount);
  const voucherDate = normalizeDate(req.body?.voucher_date);
  const prefixes = {
    CREDITOR_PAYMENT: 'CPV',
    DEBTOR_RECEIPT: 'DRV',
    EXPENSE: 'EXV',
    CUSTOMER_CREDIT: 'CCV'
  };
  const prefix = prefixes[voucherType] || 'ACV';
  const accountHolderName = String(req.body?.account_holder_name || '').trim();
  const bankName = String(req.body?.bank_name || '').trim();
  const bankAccountNo = String(req.body?.bank_account_no || '').trim();
  const bankIfsc = String(req.body?.bank_ifsc || '').trim().toUpperCase();
  const upiId = String(req.body?.upi_id || '').trim();

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
       (voucher_no, voucher_date, voucher_type, account_name, payment_mode, amount,
        account_holder_name, bank_name, bank_account_no, bank_ifsc, upi_id,
        reference_no, remarks, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        finalVoucherNo,
        voucherDate,
        voucherType,
        accountName,
        paymentMode,
        amount,
        accountHolderName,
        bankName,
        bankAccountNo,
        bankIfsc,
        upiId,
        String(req.body?.reference_no || '').trim(),
        String(req.body?.remarks || '').trim(),
        req.user.username
      ]
    );

    if (voucherType === 'CREDITOR_PAYMENT' && (accountHolderName || bankName || bankAccountNo || bankIfsc || upiId)) {
      const [updateResult] = await db.query(
        `UPDATE suppliers
         SET account_holder_name = COALESCE(NULLIF(?, ''), account_holder_name),
             bank_name = COALESCE(NULLIF(?, ''), bank_name),
             bank_account_no = COALESCE(NULLIF(?, ''), bank_account_no),
             bank_ifsc = COALESCE(NULLIF(?, ''), bank_ifsc),
             upi_id = COALESCE(NULLIF(?, ''), upi_id),
             is_active = 1,
             updated_at = CURRENT_TIMESTAMP
         WHERE supplier_name = ?`,
        [accountHolderName, bankName, bankAccountNo, bankIfsc, upiId, accountName]
      );

      if (updateResult.affectedRows === 0) {
        await db.query(
          `INSERT INTO suppliers
           (supplier_name, supplier_gstin, account_holder_name, bank_name, bank_account_no, bank_ifsc, upi_id, created_by)
           VALUES (?, '', ?, ?, ?, ?, ?, ?)`,
          [accountName, accountHolderName, bankName, bankAccountNo, bankIfsc, upiId, req.user.username]
        );
      }
    }

    res.json({ success: true, voucher_no: finalVoucherNo, voucher_type: voucherType, account_name: accountName, payment_mode: paymentMode, amount, voucher_date: voucherDate });
  } catch (err) {
    console.error('Accounting voucher save failed:', err.message);
    res.status(500).json({ error: 'Unable to save accounting voucher.' });
  }
});

module.exports = router;
