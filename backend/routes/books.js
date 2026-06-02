const express = require('express');
const router = express.Router();
const db = require('../config/db');
const { authenticate, authorize } = require('../middleware/auth');
const { normalizeDate } = require('../utils/formatters');

router.use(authenticate, authorize('SERVER', 'ADMIN'));

router.get('/summary', async (req, res) => {
  try {
    const from = normalizeDate(req.query.from || req.query.date);
    const to = normalizeDate(req.query.to || from, from);
    const month = from.slice(0, 7);
    const [salesRows] = await db.query(
      `SELECT COALESCE(SUM(grand_total), 0) AS sales,
              COALESCE(SUM(gst_total), 0) AS gst,
              COUNT(*) AS bills
       FROM invoices
       WHERE DATE(created_at) BETWEEN ? AND ? AND invoice_status <> 'CANCELLED'`,
      [from, to]
    );
    const [purchaseRows] = await db.query(
      `SELECT COALESCE(SUM(grand_total), 0) AS purchases, COUNT(*) AS entries
       FROM inward_entries
       WHERE DATE(created_at) BETWEEN ? AND ?`,
      [from, to]
    );
    const [cashRows] = await db.query(
      `SELECT COALESCE(SUM(grand_total), 0) AS cash_sales
       FROM invoices
       WHERE DATE(created_at) BETWEEN ? AND ? AND payment_mode = 'Cash' AND invoice_status <> 'CANCELLED'`,
      [from, to]
    );
    const [counterCashRows] = await db.query(
      `SELECT
         COALESCE(SUM(CASE WHEN direction = 'DR' THEN amount ELSE 0 END), 0) AS dr_total,
         COALESCE(SUM(CASE WHEN direction = 'CR' THEN amount ELSE 0 END), 0) AS cr_total
       FROM counter_cash_ledger_entries
       WHERE entry_date BETWEEN ? AND ?`,
      [from, to]
    );
    const [monthRows] = await db.query(
      `SELECT
         COALESCE((SELECT SUM(grand_total) FROM invoices WHERE DATE_FORMAT(created_at, '%Y-%m') = ? AND invoice_status <> 'CANCELLED'), 0) AS month_sales,
         COALESCE((SELECT SUM(grand_total) FROM inward_entries WHERE DATE_FORMAT(created_at, '%Y-%m') = ?), 0) AS month_purchases`,
      [month, month]
    );

    const todaySales = Number(salesRows[0]?.sales || 0);
    const todayPurchases = Number(purchaseRows[0]?.purchases || 0);
    const monthSales = Number(monthRows[0]?.month_sales || 0);
    const monthPurchases = Number(monthRows[0]?.month_purchases || 0);

    res.json({
      from,
      to,
      dayBook: { sales: todaySales, purchases: todayPurchases, bills: Number(salesRows[0]?.bills || 0), purchaseEntries: Number(purchaseRows[0]?.entries || 0) },
      cashBook: { cashSales: Number(cashRows[0]?.cash_sales || 0) },
      counterCashBook: {
        drTotal: Number(counterCashRows[0]?.dr_total || 0),
        crTotal: Number(counterCashRows[0]?.cr_total || 0),
        balance: Number(counterCashRows[0]?.dr_total || 0) - Number(counterCashRows[0]?.cr_total || 0)
      },
      purchaseBook: { purchases: todayPurchases },
      taxBook: { gstCollected: Number(salesRows[0]?.gst || 0) },
      profitLoss: { sales: monthSales, purchases: monthPurchases, estimatedGrossProfit: monthSales - monthPurchases },
      balanceSheet: { inventoryNote: 'Use stock report for current inventory valuation.' }
    });
  } catch (err) {
    console.error('Books summary failed:', err.message);
    res.status(500).json({ error: 'Unable to load books summary.' });
  }
});

router.get('/day-book', async (req, res) => {
  try {
    const from = normalizeDate(req.query.from || req.query.date);
    const to = normalizeDate(req.query.to || from, from);
    const [sales] = await db.query(
      `SELECT created_at, invoice_no AS ref_no, 'SALE' AS type, customer_name AS account, grand_total AS amount, payment_mode AS mode
       FROM invoices
       WHERE DATE(created_at) BETWEEN ? AND ? AND invoice_status <> 'CANCELLED'`,
      [from, to]
    );
    const [purchases] = await db.query(
      `SELECT created_at, inward_no AS ref_no, 'PURCHASE' AS type, supplier_name AS account, grand_total AS amount, 'Credit' AS mode
       FROM inward_entries
       WHERE DATE(created_at) BETWEEN ? AND ?`,
      [from, to]
    );
    const [counterCashLedger] = await db.query(
      `SELECT created_at,
              CONCAT(source_type, '-', COALESCE(source_id, id)) AS ref_no,
              'COUNTER_LEDGER' AS type,
              account_name AS account,
              amount,
              direction AS mode,
              details
       FROM counter_cash_ledger_entries
       WHERE entry_date BETWEEN ? AND ?`,
      [from, to]
    );
    const rows = [...sales, ...purchases, ...counterCashLedger].sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
    res.json({ from, to, rows });
  } catch (err) {
    console.error('Day book failed:', err.message);
    res.status(500).json({ error: 'Unable to load day book.' });
  }
});

module.exports = router;
