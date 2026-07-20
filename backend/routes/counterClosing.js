const express = require('express');
const router = express.Router();
const db = require('../config/db');
const { authenticate, authorize } = require('../middleware/auth');
const { writeAuditLog } = require('../services/auditService');
const { normalizeDate, parseMoney } = require('../utils/formatters');

const DENOMINATIONS = [2000, 500, 200, 100, 50, 20, 10, 5, 2, 1];
const CASH_BALANCE_LEDGER = 'Counter Cash Balance Sheet';
const AUTO_ENTRY_DETAILS = new Set(['Counter Closing Cash', 'Today Sale']);

function normalizeCounterNo(value, user) {
  if (user?.role === 'COUNTER' && user.counter_no) return Number(user.counter_no);
  return Math.max(Number.parseInt(value, 10) || 1, 1);
}

function nextIsoDate(dateText) {
  const match = String(dateText || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return dateText;
  const date = new Date(Date.UTC(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3]) + 1
  ));
  return date.toISOString().slice(0, 10);
}

function calculateDeclaredCash(denominations) {
  return DENOMINATIONS.reduce((sum, value) => {
    const count = Math.max(Number.parseInt(denominations?.[value], 10) || 0, 0);
    return sum + value * count;
  }, 0);
}

function normalizeMovements(movements) {
  if (!Array.isArray(movements)) return [];
  return movements
    .map((movement) => ({
      type: movement.type === 'IN' ? 'IN' : 'OUT',
      reason: String(movement.reason || '').trim(),
      amount: parseMoney(movement.amount)
    }))
    .filter((movement) => movement.reason && movement.amount > 0);
}

function makeSheetNo(date, counterNo) {
  return `CH-${String(date).replace(/-/g, '')}-C${counterNo}`;
}

function counterRegexForNo(counterNo) {
  const number = Number.parseInt(counterNo, 10) || 1;
  return `(^|/)Counter[[:space:]]*${number}$`;
}

function normalizeEntries(entries) {
  if (!Array.isArray(entries)) return [];
  return entries
    .map((entry, index) => ({
      line_no: Number.parseInt(entry.line_no, 10) || index + 1,
      entry_type: String(entry.entry_type || 'GENERAL').trim().slice(0, 40) || 'GENERAL',
      details: String(entry.details || '').trim().slice(0, 180),
      remarks: String(entry.remarks || '').trim().slice(0, 255),
      direction: entry.direction === 'DR' ? 'DR' : 'CR',
      amount: parseMoney(entry.amount)
    }))
    .filter((entry) => entry.details && entry.amount > 0);
}

function isAutoEntry(entry) {
  return AUTO_ENTRY_DETAILS.has(String(entry.details || '').trim());
}

function normalizeDenominationRows(denominations) {
  const source = denominations && typeof denominations === 'object' ? denominations : {};
  return DENOMINATIONS.map((value) => {
    const quantity = Math.max(Number.parseFloat(source[value]) || 0, 0);
    return {
      denomination_label: value === 1 ? 'Coins/1' : String(value),
      denomination_value: value,
      quantity,
      amount: value * quantity
    };
  }).filter((row) => row.quantity > 0);
}

async function getSalesSnapshot(date, counterNo) {
  const nextDate = nextIsoDate(date);
  const [counterRows] = await db.query(
    `SELECT
       COALESCE(SUM(amount), 0) AS total,
       COALESCE(SUM(CASE WHEN payment_mode = 'Cash' THEN amount ELSE 0 END), 0) AS cash,
       COALESCE(SUM(CASE WHEN payment_mode = 'UPI' THEN amount ELSE 0 END), 0) AS upi,
       COALESCE(SUM(CASE WHEN payment_mode = 'Card' THEN amount ELSE 0 END), 0) AS card,
       COALESCE(SUM(CASE WHEN payment_mode NOT IN ('Cash', 'UPI', 'Card') OR payment_mode IS NULL THEN amount ELSE 0 END), 0) AS other
     FROM (
       SELECT ip.payment_mode, ip.amount
       FROM invoice_payments ip
       INNER JOIN invoices i ON i.invoice_no = ip.invoice_no
       WHERE DATE(i.created_at) = ?
         AND i.billing_counter REGEXP ?
         AND i.invoice_status <> 'CANCELLED'
       UNION ALL
       SELECT i.payment_mode, i.grand_total AS amount
       FROM invoices i
       LEFT JOIN invoice_payments ip ON ip.invoice_no = i.invoice_no
       WHERE DATE(i.created_at) = ?
         AND i.billing_counter REGEXP ?
         AND i.invoice_status <> 'CANCELLED'
         AND ip.id IS NULL
     ) payments`,
    [date, counterRegexForNo(counterNo), date, counterRegexForNo(counterNo)]
  );
  const [allRows] = await db.query(
    `SELECT COALESCE(SUM(amount), 0) AS total
     FROM (
       SELECT ip.amount
       FROM invoice_payments ip
       INNER JOIN invoices i ON i.invoice_no = ip.invoice_no
       WHERE DATE(i.created_at) = ?
         AND i.invoice_status <> 'CANCELLED'
       UNION ALL
       SELECT i.grand_total AS amount
       FROM invoices i
       LEFT JOIN invoice_payments ip ON ip.invoice_no = i.invoice_no
       WHERE DATE(i.created_at) = ?
         AND i.invoice_status <> 'CANCELLED'
         AND ip.id IS NULL
     ) payments`,
    [date, date]
  );
  const [counterExchangeRows] = await db.query(
    `SELECT
       COALESCE(SUM(CASE WHEN exchange_total > 0 THEN 1 ELSE 0 END), 0) AS exchange_bill_count,
       COALESCE(SUM(CASE WHEN exchange_total > 0 THEN sub_total + gst_total ELSE 0 END), 0) AS exchange_sale_total,
       COALESCE(SUM(exchange_total), 0) AS exchange_less,
       COALESCE(SUM(CASE WHEN exchange_total > 0 THEN grand_total ELSE 0 END), 0) AS exchange_net_total
     FROM invoices
     WHERE created_at >= ? AND created_at < ?
       AND billing_counter REGEXP ?
       AND invoice_status <> 'CANCELLED'`,
    [date, nextDate, counterRegexForNo(counterNo)]
  );
  const [allExchangeRows] = await db.query(
    `SELECT
       COALESCE(SUM(CASE WHEN exchange_total > 0 THEN 1 ELSE 0 END), 0) AS exchange_bill_count,
       COALESCE(SUM(CASE WHEN exchange_total > 0 THEN sub_total + gst_total ELSE 0 END), 0) AS exchange_sale_total,
       COALESCE(SUM(exchange_total), 0) AS exchange_less,
       COALESCE(SUM(CASE WHEN exchange_total > 0 THEN grand_total ELSE 0 END), 0) AS exchange_net_total
     FROM invoices
     WHERE created_at >= ? AND created_at < ?
       AND invoice_status <> 'CANCELLED'`,
    [date, nextDate]
  );
  const [latestRows] = await db.query(
    `SELECT DATE_FORMAT(MAX(created_at), '%Y-%m-%d') AS latest_invoice_date,
            COUNT(*) AS invoice_count
     FROM invoices
     WHERE invoice_status <> 'CANCELLED'`
  );

  return {
    counter_sales: Number(counterRows[0]?.total || 0),
    all_counter_sales: Number(allRows[0]?.total || 0),
    cash_sales: Number(counterRows[0]?.cash || 0),
    upi_sales: Number(counterRows[0]?.upi || 0),
    card_sales: Number(counterRows[0]?.card || 0),
    other_sales: Number(counterRows[0]?.other || 0),
    exchange_bill_count: Number(counterExchangeRows[0]?.exchange_bill_count || 0),
    exchange_sale_total: Number(counterExchangeRows[0]?.exchange_sale_total || 0),
    exchange_less: Number(counterExchangeRows[0]?.exchange_less || 0),
    exchange_net_total: Number(counterExchangeRows[0]?.exchange_net_total || 0),
    all_exchange_bill_count: Number(allExchangeRows[0]?.exchange_bill_count || 0),
    all_exchange_sale_total: Number(allExchangeRows[0]?.exchange_sale_total || 0),
    all_exchange_less: Number(allExchangeRows[0]?.exchange_less || 0),
    all_exchange_net_total: Number(allExchangeRows[0]?.exchange_net_total || 0),
    latest_invoice_date: latestRows[0]?.latest_invoice_date || null,
    invoice_count: Number(latestRows[0]?.invoice_count || 0)
  };
}

async function loadHandoverSheet(date, counterNo) {
  const [sheetRows] = await db.query(
    `SELECT id, DATE_FORMAT(closing_date, '%Y-%m-%d') AS closing_date, counter_no, sheet_no,
            opening_cash, counter_sales, all_counter_sales, cash_sales, upi_sales, card_sales,
            dr_total, cr_total, notes_total, cash_balance, variance_amount,
            handed_over_by, taken_over_by, notes, created_by,
            DATE_FORMAT(created_at, '%Y-%m-%d %H:%i:%s') AS created_at,
            DATE_FORMAT(updated_at, '%Y-%m-%d %H:%i:%s') AS updated_at
     FROM counter_handover_sheets
     WHERE closing_date = ? AND counter_no = ?
     LIMIT 1`,
    [date, counterNo]
  );
  const sheet = sheetRows[0] || null;
  if (!sheet) return null;

  const [entries] = await db.query(
    `SELECT line_no, entry_type, details, remarks, direction, amount
     FROM counter_handover_entries
     WHERE sheet_id = ?
     ORDER BY line_no ASC, id ASC`,
    [sheet.id]
  );
  const [denominations] = await db.query(
    `SELECT denomination_label, denomination_value, quantity, amount
     FROM counter_handover_denominations
     WHERE sheet_id = ?
     ORDER BY denomination_value DESC`,
    [sheet.id]
  );

  return { ...sheet, entries, denominations };
}

async function getExpectedTotals(date, counterNo) {
  const [rows] = await db.query(
    `SELECT payment_mode, COALESCE(SUM(amount), 0) AS total
     FROM (
       SELECT ip.payment_mode, ip.amount
       FROM invoice_payments ip
       INNER JOIN invoices i ON i.invoice_no = ip.invoice_no
       WHERE DATE(i.created_at) = ?
         AND i.billing_counter REGEXP ?
         AND i.invoice_status <> 'CANCELLED'
       UNION ALL
       SELECT i.payment_mode, i.grand_total AS amount
       FROM invoices i
       LEFT JOIN invoice_payments ip ON ip.invoice_no = i.invoice_no
       WHERE DATE(i.created_at) = ?
         AND i.billing_counter REGEXP ?
         AND i.invoice_status <> 'CANCELLED'
         AND ip.id IS NULL
     ) payments
     GROUP BY payment_mode`,
    [date, counterRegexForNo(counterNo), date, counterRegexForNo(counterNo)]
  );

  const totals = { Cash: 0, UPI: 0, Card: 0 };
  rows.forEach((row) => {
    totals[row.payment_mode] = Number(row.total || 0);
  });
  return totals;
}

router.use(authenticate, authorize('SERVER', 'ADMIN', 'COUNTER'));

router.get('/handover', async (req, res) => {
  try {
    const date = normalizeDate(req.query.date);
    const counterNo = normalizeCounterNo(req.query.counter_no, req.user);
    const [snapshot, sheet] = await Promise.all([
      getSalesSnapshot(date, counterNo),
      loadHandoverSheet(date, counterNo)
    ]);

    res.json({
      date,
      counter_no: counterNo,
      sheet_no: makeSheetNo(date, counterNo),
      snapshot,
      sheet,
      denominations: DENOMINATIONS
    });
  } catch (err) {
    console.error('Counter handover load failed:', err.message);
    res.status(500).json({ error: 'Unable to load counter handover sheet.' });
  }
});

router.get('/handover/history', authorize('SERVER', 'ADMIN'), async (req, res) => {
  try {
    const from = normalizeDate(req.query.from || req.query.date);
    const to = normalizeDate(req.query.to || from, from);
    const params = [from, to];
    let counterClause = '';
    const counterNo = Number.parseInt(req.query.counter_no, 10);
    if (counterNo > 0) {
      counterClause = ' AND counter_no = ?';
      params.push(counterNo);
    }

    const [rows] = await db.query(
      `SELECT id, DATE_FORMAT(closing_date, '%Y-%m-%d') AS closing_date, counter_no, sheet_no, counter_sales, all_counter_sales,
              dr_total, cr_total, notes_total, cash_balance, variance_amount,
              handed_over_by, taken_over_by,
              DATE_FORMAT(created_at, '%Y-%m-%d %H:%i:%s') AS created_at,
              DATE_FORMAT(updated_at, '%Y-%m-%d %H:%i:%s') AS updated_at
       FROM counter_handover_sheets
       WHERE closing_date BETWEEN ? AND ?${counterClause}
       ORDER BY closing_date DESC, counter_no ASC`,
      params
    );
    res.json({ from, to, rows });
  } catch (err) {
    console.error('Counter handover history failed:', err.message);
    res.status(500).json({ error: 'Unable to load handover sheet history.' });
  }
});

router.post('/handover', async (req, res) => {
  const date = normalizeDate(req.body?.date);
  const counterNo = normalizeCounterNo(req.body?.counter_no, req.user);
  const openingCash = parseMoney(req.body?.opening_cash);
  const entries = normalizeEntries(req.body?.entries);
  const denominationRows = normalizeDenominationRows(req.body?.denominations);
  const defaultPerson = req.user?.username || `Counter ${counterNo}`;
  const handedOverBy = String(req.body?.handed_over_by || defaultPerson).trim() || defaultPerson;
  const takenOverBy = String(req.body?.taken_over_by || defaultPerson).trim() || defaultPerson;
  const notes = String(req.body?.notes || '').trim();

  try {
    const snapshot = await getSalesSnapshot(date, counterNo);
    const notesTotal = denominationRows.reduce((sum, row) => sum + row.amount, 0);
    const manualEntries = entries.filter((entry) => !isAutoEntry(entry));
    const closingEntries = [
      ...manualEntries,
      { line_no: manualEntries.length + 1, entry_type: 'CLOSING_BASE', details: 'Counter Closing Cash', remarks: 'Auto from opening cash', direction: 'CR', amount: openingCash },
      { line_no: manualEntries.length + 2, entry_type: 'SALES', details: 'Today Sale', remarks: 'Auto counter sales total', direction: 'CR', amount: snapshot.counter_sales }
    ].filter((entry) => entry.amount > 0);
    const entryDrTotal = closingEntries.filter((entry) => entry.direction === 'DR').reduce((sum, entry) => sum + entry.amount, 0);
    const entryCrTotal = closingEntries.filter((entry) => entry.direction === 'CR').reduce((sum, entry) => sum + entry.amount, 0);
    const drTotal = entryDrTotal + notesTotal;
    const crTotal = entryCrTotal;
    const cashBalance = notesTotal;
    const varianceAmount = drTotal - crTotal;
    const sheetNo = makeSheetNo(date, counterNo);

    const connection = await db.getConnection();
    try {
      await connection.beginTransaction();
      await connection.query(
        `INSERT INTO counter_handover_sheets
         (closing_date, counter_no, sheet_no, opening_cash, counter_sales, all_counter_sales,
          cash_sales, upi_sales, card_sales, dr_total, cr_total, notes_total, cash_balance,
          variance_amount, handed_over_by, taken_over_by, notes, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
           opening_cash = VALUES(opening_cash),
           counter_sales = VALUES(counter_sales),
           all_counter_sales = VALUES(all_counter_sales),
           cash_sales = VALUES(cash_sales),
           upi_sales = VALUES(upi_sales),
           card_sales = VALUES(card_sales),
           dr_total = VALUES(dr_total),
           cr_total = VALUES(cr_total),
           notes_total = VALUES(notes_total),
           cash_balance = VALUES(cash_balance),
           variance_amount = VALUES(variance_amount),
           handed_over_by = VALUES(handed_over_by),
           taken_over_by = VALUES(taken_over_by),
           notes = VALUES(notes),
           created_by = VALUES(created_by),
           updated_at = CURRENT_TIMESTAMP`,
        [
          date,
          counterNo,
          sheetNo,
          openingCash,
          snapshot.counter_sales,
          snapshot.all_counter_sales,
          snapshot.cash_sales,
          snapshot.upi_sales,
          snapshot.card_sales,
          drTotal,
          crTotal,
          notesTotal,
          cashBalance,
          varianceAmount,
          handedOverBy,
          takenOverBy,
          notes,
          req.user.username
        ]
      );

      const [sheetRows] = await connection.query(
        `SELECT id,
                DATE_FORMAT(created_at, '%Y-%m-%d %H:%i:%s') AS created_at,
                DATE_FORMAT(updated_at, '%Y-%m-%d %H:%i:%s') AS updated_at
         FROM counter_handover_sheets
         WHERE closing_date = ? AND counter_no = ?
         LIMIT 1`,
        [date, counterNo]
      );
      const sheetId = sheetRows[0].id;
      const savedCreatedAt = sheetRows[0].created_at || '';
      const savedUpdatedAt = sheetRows[0].updated_at || '';

      await connection.query('DELETE FROM counter_handover_entries WHERE sheet_id = ?', [sheetId]);
      await connection.query('DELETE FROM counter_handover_denominations WHERE sheet_id = ?', [sheetId]);
      await connection.query(
        `DELETE FROM counter_cash_ledger_entries WHERE source_type = 'COUNTER_HANDOVER' AND source_id = ?`,
        [sheetId]
      );

      if (closingEntries.length) {
        const handoverEntryRows = closingEntries.map((entry) => [
          sheetId, entry.line_no, entry.entry_type, entry.details, entry.remarks, entry.direction, entry.amount
        ]);
        await connection.query(
          `INSERT INTO counter_handover_entries
           (sheet_id, line_no, entry_type, details, remarks, direction, amount)
           VALUES ?`,
          [handoverEntryRows]
        );

        const ledgerRows = closingEntries.map((entry) => [
          date,
          counterNo,
          sheetId,
          entry.entry_type === 'EXPENSE' ? `Expense - ${entry.details}` : entry.details,
          entry.remarks || `${sheetNo} Counter ${counterNo}`,
          entry.direction,
          entry.amount,
          entry.entry_type,
          req.user.username
        ]);
        await connection.query(
          `INSERT INTO counter_cash_ledger_entries
           (entry_date, counter_no, source_type, source_id, account_name, details, direction, amount, payment_mode, created_by)
           VALUES ?`,
          [ledgerRows.map((row) => [row[0], row[1], 'COUNTER_HANDOVER', ...row.slice(2)])]
        );
      }

      if (denominationRows.length) {
        const savedDenominationRows = denominationRows.map((row) => [
          sheetId, row.denomination_label, row.denomination_value, row.quantity, row.amount
        ]);
        await connection.query(
          `INSERT INTO counter_handover_denominations
           (sheet_id, denomination_label, denomination_value, quantity, amount)
           VALUES ?`,
          [savedDenominationRows]
        );
      }

      let ledgerEntryCount = closingEntries.length;

      if (cashBalance > 0) {
        await connection.query(
          `INSERT INTO counter_cash_ledger_entries
           (entry_date, counter_no, source_type, source_id, account_name, details, direction, amount, payment_mode, created_by)
           VALUES (?, ?, 'COUNTER_HANDOVER', ?, ?, ?, 'DR', ?, 'CASH_NOTES', ?)`,
          [
            date,
            counterNo,
            sheetId,
            CASH_BALANCE_LEDGER,
            `${sheetNo} Counter ${counterNo} cash notes balance`,
            cashBalance,
            req.user.username
          ]
        );
        ledgerEntryCount += 1;
      }

      await writeAuditLog({
        user: req.user,
        action: 'COUNTER_HANDOVER_SAVED',
        entityType: 'COUNTER_HANDOVER',
        entityId: sheetNo,
        details: { counterNo, drTotal, crTotal, cashBalance, varianceAmount },
        connection
      });

      await connection.commit();

      res.json({
        success: true,
        id: sheetId,
        date,
        counter_no: counterNo,
        sheet_no: sheetNo,
        created_at: savedCreatedAt,
        updated_at: savedUpdatedAt,
        snapshot,
        dr_total: drTotal,
        cr_total: crTotal,
        notes_total: notesTotal,
        cash_balance: cashBalance,
        variance_amount: varianceAmount,
        ledger_entry_count: ledgerEntryCount
      });
    } catch (err) {
      await connection.rollback();
      throw err;
    } finally {
      connection.release();
    }
  } catch (err) {
    console.error('Counter handover save failed:', err.message);
    res.status(500).json({ error: 'Unable to save counter handover sheet.' });
  }
});

router.get('/expected', async (req, res) => {
  try {
    const date = normalizeDate(req.query.date);
    const counterNo = normalizeCounterNo(req.query.counter_no, req.user);
    const expected = await getExpectedTotals(date, counterNo);
    const [closingRows] = await db.query(
      `SELECT *
       FROM counter_closings
       WHERE closing_date = ? AND counter_no = ?
       LIMIT 1`,
      [date, counterNo]
    );

    res.json({
      date,
      counter_no: counterNo,
      expected,
      closing: closingRows[0] || null,
      denominations: DENOMINATIONS
    });
  } catch (err) {
    console.error('Counter expected totals failed:', err.message);
    res.status(500).json({ error: 'Unable to fetch counter totals.' });
  }
});

router.get('/summary', authorize('SERVER', 'ADMIN'), async (req, res) => {
  try {
    const date = normalizeDate(req.query.date);
    const [rows] = await db.query(
      `SELECT *
       FROM counter_closings
       WHERE closing_date = ?
       ORDER BY counter_no ASC`,
      [date]
    );

    const totals = rows.reduce((acc, row) => ({
      expectedCash: acc.expectedCash + Number(row.expected_cash_sales || 0),
      expectedUpi: acc.expectedUpi + Number(row.expected_upi_sales || 0),
      expectedCard: acc.expectedCard + Number(row.expected_card_sales || 0),
      declaredCash: acc.declaredCash + Number(row.declared_cash_total || 0),
      difference: acc.difference + Number(row.difference_amount || 0)
    }), { expectedCash: 0, expectedUpi: 0, expectedCard: 0, declaredCash: 0, difference: 0 });

    res.json({ date, rows, totals });
  } catch (err) {
    console.error('Counter closing summary failed:', err.message);
    res.status(500).json({ error: 'Unable to fetch counter closing summary.' });
  }
});

router.post('/', async (req, res) => {
  const date = normalizeDate(req.body?.date);
  const counterNo = normalizeCounterNo(req.body?.counter_no, req.user);
  const openingCash = parseMoney(req.body?.opening_cash);
  const denominations = req.body?.denominations || {};
  const movements = normalizeMovements(req.body?.movements);
  const handedOverBy = String(req.body?.handed_over_by || '').trim();
  const takenOverBy = String(req.body?.taken_over_by || '').trim();
  const notes = String(req.body?.notes || '').trim();

  if (!handedOverBy || !takenOverBy) {
    return res.status(400).json({ error: 'Handed over by and taken over by are required.' });
  }

  try {
    const expected = await getExpectedTotals(date, counterNo);
    const cashInTotal = movements.filter((movement) => movement.type === 'IN').reduce((sum, movement) => sum + movement.amount, 0);
    const cashOutTotal = movements.filter((movement) => movement.type === 'OUT').reduce((sum, movement) => sum + movement.amount, 0);
    const declaredCashTotal = calculateDeclaredCash(denominations);
    const expectedCashInHand = openingCash + expected.Cash + cashInTotal - cashOutTotal;
    const differenceAmount = declaredCashTotal - expectedCashInHand;

    await db.query(
      `INSERT INTO counter_closings
       (closing_date, counter_no, opening_cash, expected_cash_sales, expected_upi_sales, expected_card_sales,
        cash_in_total, cash_out_total, declared_cash_total, expected_cash_in_hand, difference_amount,
        denominations_json, movements_json, handed_over_by, taken_over_by, notes, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         opening_cash = VALUES(opening_cash),
         expected_cash_sales = VALUES(expected_cash_sales),
         expected_upi_sales = VALUES(expected_upi_sales),
         expected_card_sales = VALUES(expected_card_sales),
         cash_in_total = VALUES(cash_in_total),
         cash_out_total = VALUES(cash_out_total),
         declared_cash_total = VALUES(declared_cash_total),
         expected_cash_in_hand = VALUES(expected_cash_in_hand),
         difference_amount = VALUES(difference_amount),
         denominations_json = VALUES(denominations_json),
         movements_json = VALUES(movements_json),
         handed_over_by = VALUES(handed_over_by),
         taken_over_by = VALUES(taken_over_by),
         notes = VALUES(notes),
         created_by = VALUES(created_by)`,
      [
        date,
        counterNo,
        openingCash,
        expected.Cash,
        expected.UPI,
        expected.Card,
        cashInTotal,
        cashOutTotal,
        declaredCashTotal,
        expectedCashInHand,
        differenceAmount,
        JSON.stringify(denominations),
        JSON.stringify(movements),
        handedOverBy,
        takenOverBy,
        notes,
        req.user.username
      ]
    );

    await writeAuditLog({
      user: req.user,
      action: 'COUNTER_CLOSING_SAVED',
      entityType: 'COUNTER_CLOSING',
      entityId: `${date}-C${counterNo}`,
      details: { expectedCashInHand, declaredCashTotal, differenceAmount }
    });

    res.json({
      success: true,
      date,
      counter_no: counterNo,
      expected,
      cash_in_total: cashInTotal,
      cash_out_total: cashOutTotal,
      declared_cash_total: declaredCashTotal,
      expected_cash_in_hand: expectedCashInHand,
      difference_amount: differenceAmount
    });
  } catch (err) {
    console.error('Counter closing save failed:', err.message);
    res.status(500).json({ error: 'Unable to save counter closing.' });
  }
});

module.exports = router;
