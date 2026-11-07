const express = require('express');
const router = express.Router();
const db = require('../config/db');
const { authenticate, authorize } = require('../middleware/auth');
const { normalizeDate, parseMoney } = require('../utils/formatters');

const { financialDocumentNo } = require('../utils/financialDocumentNo');

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

  let connection;
  try {
    connection = await db.getConnection();
    await connection.beginTransaction();
    const finalVoucherNo = financialDocumentNo(prefix);
    await connection.query(
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
      const bankDetails = [accountHolderName, bankName, bankAccountNo, bankIfsc, upiId];
      const updateBankDetails = `account_holder_name = COALESCE(NULLIF(?, ''), account_holder_name),
             bank_name = COALESCE(NULLIF(?, ''), bank_name),
             bank_account_no = COALESCE(NULLIF(?, ''), bank_account_no),
             bank_ifsc = COALESCE(NULLIF(?, ''), bank_ifsc),
             upi_id = COALESCE(NULLIF(?, ''), upi_id),
             is_active = 1, updated_at = CURRENT_TIMESTAMP`;
      const [suppliers] = await connection.query('SELECT id FROM suppliers WHERE supplier_name = ? ORDER BY id', [accountName]);
      if (suppliers.length) {
        await connection.query(`UPDATE suppliers SET ${updateBankDetails} WHERE id IN (?)`,
          [...bankDetails, suppliers.map(supplier => supplier.id)]);
      } else {
        // Another counter can create the same supplier after our lookup.
        await connection.query(
          `INSERT INTO suppliers
           (supplier_name, supplier_gstin, account_holder_name, bank_name, bank_account_no, bank_ifsc, upi_id, created_by)
           VALUES (?, '', ?, ?, ?, ?, ?, ?)
           ON DUPLICATE KEY UPDATE ${updateBankDetails}`,
          [accountName, ...bankDetails, req.user.username, ...bankDetails]
        );
      }
    }

    await connection.commit();
    res.json({ success: true, voucher_no: finalVoucherNo, voucher_type: voucherType, account_name: accountName, payment_mode: paymentMode, amount, voucher_date: voucherDate });
  } catch (err) {
    if (connection) {
      try {
        await connection.rollback();
      } catch (rollbackError) {
        connection.destroy();
        connection = null;
        console.error('Accounting voucher rollback failed:', rollbackError.message);
      }
    }
    console.error('Accounting voucher save failed:', err.message);
    res.status(500).json({ error: 'Unable to save accounting voucher.' });
  } finally {
    connection?.release();
  }
});

module.exports = router;
