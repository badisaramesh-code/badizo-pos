const express = require('express');
const router = express.Router();
const db = require('../config/db');
const { authenticate, authorize } = require('../middleware/auth');
const { writeAuditLog } = require('../services/auditService');
const { normalizeDate, parseMoney } = require('../utils/formatters');

const DENOMINATIONS = [2000, 500, 200, 100, 50, 20, 10, 5, 2, 1];

function normalizeCounterNo(value, user) {
  if (user?.role === 'COUNTER' && user.counter_no) return Number(user.counter_no);
  return Math.max(Number.parseInt(value, 10) || 1, 1);
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

async function getExpectedTotals(date, counterNo) {
  const [rows] = await db.query(
    `SELECT payment_mode, COALESCE(SUM(grand_total), 0) AS total
     FROM invoices
     WHERE DATE(created_at) = ?
       AND billing_counter = ?
       AND invoice_status <> 'CANCELLED'
     GROUP BY payment_mode`,
    [date, `Counter ${counterNo}`]
  );

  const totals = { Cash: 0, UPI: 0, Card: 0 };
  rows.forEach((row) => {
    totals[row.payment_mode] = Number(row.total || 0);
  });
  return totals;
}

router.use(authenticate, authorize('SERVER', 'ADMIN', 'COUNTER'));

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
