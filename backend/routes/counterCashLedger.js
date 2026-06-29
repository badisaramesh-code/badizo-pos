const express = require('express');
const router = express.Router();
const db = require('../config/db');
const { authenticate, authorize } = require('../middleware/auth');
const { writeAuditLog } = require('../services/auditService');
const { normalizeDate, parseMoney } = require('../utils/formatters');

function normalizeCounterNo(value) {
  const parsed = Number.parseInt(value, 10);
  return parsed > 0 ? parsed : 0;
}

function normalizeDirection(value) {
  return value === 'DR' ? 'DR' : 'CR';
}

function normalizeManualAmount(body) {
  const dr = parseMoney(body?.dr_amount);
  const cr = parseMoney(body?.cr_amount);
  if (dr > 0 && cr > 0) {
    const err = new Error('Enter either DR or CR amount, not both.');
    err.statusCode = 400;
    throw err;
  }
  if (dr > 0) return { direction: 'DR', amount: dr };
  if (cr > 0) return { direction: 'CR', amount: cr };

  const amount = parseMoney(body?.amount);
  return { direction: normalizeDirection(body?.direction), amount };
}

router.use(authenticate, authorize('SERVER', 'ADMIN'));

router.get('/', async (req, res) => {
  try {
    const from = normalizeDate(req.query.from || req.query.date);
    const to = normalizeDate(req.query.to || from, from);
    const counterNo = normalizeCounterNo(req.query.counter_no);
    const range = from <= to ? { from, to } : { from: to, to: from };
    const manualParams = [range.from, range.to];
    const handoverParams = [range.from, range.to];
    const priorManualParams = [range.from];
    const priorHandoverParams = [range.from];
    let manualCounterSql = '';
    let handoverCounterSql = '';
    let priorManualCounterSql = '';
    let priorHandoverCounterSql = '';

    if (counterNo > 0) {
      manualCounterSql = ' AND cle.counter_no = ?';
      handoverCounterSql = ' AND chs.counter_no = ?';
      priorManualCounterSql = ' AND counter_no = ?';
      priorHandoverCounterSql = ' AND counter_no = ?';
      manualParams.push(counterNo);
      handoverParams.push(counterNo);
      priorManualParams.push(counterNo);
      priorHandoverParams.push(counterNo);
    }

    const [priorManualRows] = await db.query(
      `SELECT
         COALESCE(SUM(CASE WHEN direction = 'DR' THEN amount ELSE -amount END), 0) AS opening_balance
       FROM counter_cash_ledger_entries
       WHERE entry_date < ?
         AND source_type <> 'COUNTER_HANDOVER'
         ${priorManualCounterSql}`,
      priorManualParams
    );

    const [priorHandoverRows] = await db.query(
      `SELECT COALESCE(SUM(cash_balance), 0) AS opening_balance
       FROM counter_handover_sheets
       WHERE closing_date < ?
         ${priorHandoverCounterSql}`,
      priorHandoverParams
    );

    const [manualRows] = await db.query(
      `SELECT
         cle.id,
         DATE_FORMAT(cle.entry_date, '%Y-%m-%d') AS entry_date,
         cle.counter_no,
         cle.source_type,
         cle.source_id,
         cle.account_name,
         cle.details,
         cle.direction,
         cle.amount,
         cle.payment_mode,
         cle.created_by,
         DATE_FORMAT(cle.created_at, '%Y-%m-%d %H:%i:%s') AS created_at,
         '' AS sheet_no,
         '' AS denomination_details
       FROM counter_cash_ledger_entries cle
       WHERE cle.entry_date BETWEEN ? AND ?
         AND cle.source_type <> 'COUNTER_HANDOVER'
         ${manualCounterSql}
       ORDER BY cle.entry_date ASC, cle.id ASC`,
      manualParams
    );

    const [handoverRows] = await db.query(
      `SELECT
         chs.id,
         DATE_FORMAT(chs.closing_date, '%Y-%m-%d') AS entry_date,
         chs.counter_no,
         'COUNTER_HANDOVER' AS source_type,
         chs.id AS source_id,
         'Counter Cash Balance Sheet' AS account_name,
         CONCAT(chs.sheet_no, ' Counter ', chs.counter_no, ' cash notes balance') AS details,
         'DR' AS direction,
         chs.cash_balance AS amount,
         'CASH_NOTES' AS payment_mode,
         chs.created_by,
         DATE_FORMAT(chs.created_at, '%Y-%m-%d %H:%i:%s') AS created_at,
         chs.sheet_no,
         COALESCE(
           GROUP_CONCAT(
             CONCAT(
               CASE
                 WHEN chd.denomination_value = FLOOR(chd.denomination_value)
                 THEN CAST(FLOOR(chd.denomination_value) AS CHAR)
                 ELSE CAST(chd.denomination_value AS CHAR)
               END,
               ' x ',
               CASE
                 WHEN chd.quantity = FLOOR(chd.quantity)
                 THEN CAST(FLOOR(chd.quantity) AS CHAR)
                 ELSE CAST(chd.quantity AS CHAR)
               END
             )
             ORDER BY chd.denomination_value DESC
             SEPARATOR ', '
           ),
           ''
         ) AS denomination_details
       FROM counter_handover_sheets chs
       LEFT JOIN counter_handover_denominations chd
         ON chd.sheet_id = chs.id
       WHERE chs.closing_date BETWEEN ? AND ?
         ${handoverCounterSql}
       GROUP BY chs.id
       HAVING amount > 0
       ORDER BY chs.closing_date ASC, chs.counter_no ASC, chs.id ASC`,
      handoverParams
    );

    const rows = [...handoverRows, ...manualRows].sort((a, b) => {
      const dateCompare = String(a.entry_date).localeCompare(String(b.entry_date));
      if (dateCompare !== 0) return dateCompare;
      const aSourceOrder = a.source_type === 'COUNTER_HANDOVER' ? 0 : 1;
      const bSourceOrder = b.source_type === 'COUNTER_HANDOVER' ? 0 : 1;
      if (aSourceOrder !== bSourceOrder) return aSourceOrder - bSourceOrder;
      return Number(a.id || 0) - Number(b.id || 0);
    });

    const openingBalance = Number(priorManualRows[0]?.opening_balance || 0)
      + Number(priorHandoverRows[0]?.opening_balance || 0);
    let balance = openingBalance;
    const normalizedRows = rows.map((row) => {
      const amount = Number(row.amount || 0);
      balance += row.direction === 'DR' ? amount : -amount;
      const isCounterCash = row.source_type === 'COUNTER_HANDOVER' && row.payment_mode === 'CASH_NOTES';
      const details = isCounterCash
        ? [row.sheet_no || row.details, row.denomination_details].filter(Boolean).join(' - ')
        : row.details;
      return {
        ...row,
        details,
        dr_amount: row.direction === 'DR' ? amount : 0,
        cr_amount: row.direction === 'CR' ? amount : 0,
        cash_balance: balance
      };
    });

    const totals = normalizedRows.reduce((acc, row) => ({
      dr: acc.dr + Number(row.dr_amount || 0),
      cr: acc.cr + Number(row.cr_amount || 0)
    }), { dr: 0, cr: 0 });

    res.json({
      from: range.from,
      to: range.to,
      counter_no: counterNo || '',
      opening_balance: openingBalance,
      closing_balance: balance,
      totals,
      rows: normalizedRows
    });
  } catch (err) {
    console.error('Counter cash ledger load failed:', err.message);
    res.status(500).json({ error: 'Unable to load counter cash ledger.' });
  }
});

router.post('/', async (req, res) => {
  try {
    const entryDate = normalizeDate(req.body?.date);
    const counterNo = normalizeCounterNo(req.body?.counter_no) || null;
    const details = String(req.body?.details || '').trim().slice(0, 255);
    const { direction, amount } = normalizeManualAmount(req.body);

    if (!details) return res.status(400).json({ error: 'Details are required.' });
    if (amount <= 0) return res.status(400).json({ error: 'Enter an amount greater than zero.' });

    const [result] = await db.query(
      `INSERT INTO counter_cash_ledger_entries
       (entry_date, counter_no, source_type, account_name, details, direction, amount, payment_mode, created_by)
       VALUES (?, ?, 'MANUAL_CASH_USAGE', ?, ?, ?, ?, 'CASH', ?)`,
      [
        entryDate,
        counterNo,
        direction === 'CR' ? 'Cash Used / Deposit' : 'Cash Received / Return',
        details,
        direction,
        amount,
        req.user.username
      ]
    );

    await writeAuditLog({
      user: req.user,
      action: 'COUNTER_CASH_LEDGER_MANUAL_ENTRY',
      entityType: 'COUNTER_CASH_LEDGER',
      entityId: result.insertId,
      details: { entryDate, counterNo, direction, amount }
    });

    res.json({ success: true, id: result.insertId, date: entryDate, counter_no: counterNo, direction, amount });
  } catch (err) {
    console.error('Counter cash ledger manual entry failed:', err.message);
    res.status(err.statusCode || 500).json({ error: err.statusCode ? err.message : 'Unable to save cash ledger entry.' });
  }
});

module.exports = router;
