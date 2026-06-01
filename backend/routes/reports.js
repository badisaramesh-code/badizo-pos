const express = require('express');
const router = express.Router();
const db = require('../config/db');
const { authenticate, authorize } = require('../middleware/auth');
const { csvLine, normalizeDate, todayIso } = require('../utils/formatters');

function normalizeCounter(value) {
  const text = String(value || '').trim();
  return /^Counter \d+$/.test(text) ? text : '';
}

router.use(authenticate);

router.get('/dashboard', authorize('SERVER', 'ADMIN'), async (_req, res) => {
  try {
    const date = todayIso();
    const [todayRows] = await db.query(
      `SELECT
         COUNT(*) AS bill_count,
         COALESCE(SUM(grand_total), 0) AS sales_total,
         COALESCE(SUM(gst_total), 0) AS gst_total,
         COALESCE(AVG(grand_total), 0) AS average_bill
       FROM invoices
       WHERE DATE(created_at) = ?`,
      [date]
    );

    const [productRows] = await db.query(
      `SELECT
         COUNT(*) AS total_products,
         COALESCE(SUM(CASE WHEN stock_qty <= min_stock_alert THEN 1 ELSE 0 END), 0) AS low_stock_count
       FROM products`
    );

    const [counterRows] = await db.query(
      `SELECT billing_counter, COUNT(*) AS bill_count, COALESCE(SUM(grand_total), 0) AS sales_total
       FROM invoices
       WHERE DATE(created_at) = ?
       GROUP BY billing_counter
       ORDER BY billing_counter ASC`,
      [date]
    );

    const [paymentRows] = await db.query(
      `SELECT payment_mode, COALESCE(SUM(grand_total), 0) AS sales_total
       FROM invoices
       WHERE DATE(created_at) = ?
       GROUP BY payment_mode`,
      [date]
    );

    const [topProductRows] = await db.query(
      `SELECT ii.product_name, SUM(ii.quantity) AS quantity, SUM(ii.quantity * ii.sale_price) AS sales_total
       FROM invoice_items ii
       INNER JOIN invoices i ON i.invoice_no = ii.invoice_no
       WHERE DATE(i.created_at) = ?
       GROUP BY ii.barcode, ii.product_name
       ORDER BY quantity DESC
       LIMIT 5`,
      [date]
    );

    const [lowStockRows] = await db.query(
      `SELECT product_name, barcode, stock_qty, min_stock_alert
       FROM products
       WHERE stock_qty <= min_stock_alert
       ORDER BY stock_qty ASC, product_name ASC
       LIMIT 10`
    );

    res.json({
      today: {
        date,
        billCount: Number(todayRows[0]?.bill_count || 0),
        salesTotal: Number(todayRows[0]?.sales_total || 0),
        gstTotal: Number(todayRows[0]?.gst_total || 0),
        averageBill: Number(todayRows[0]?.average_bill || 0)
      },
      products: {
        totalProducts: Number(productRows[0]?.total_products || 0),
        lowStockCount: Number(productRows[0]?.low_stock_count || 0)
      },
      counters: counterRows.map((row) => ({
        counter: row.billing_counter,
        billCount: Number(row.bill_count || 0),
        salesTotal: Number(row.sales_total || 0)
      })),
      payments: paymentRows.map((row) => ({
        mode: row.payment_mode,
        salesTotal: Number(row.sales_total || 0)
      })),
      topProducts: topProductRows.map((row) => ({
        productName: row.product_name,
        quantity: Number(row.quantity || 0),
        salesTotal: Number(row.sales_total || 0)
      })),
      lowStock: lowStockRows.map((row) => ({
        productName: row.product_name,
        barcode: row.barcode,
        stockQty: Number(row.stock_qty || 0),
        minStockAlert: Number(row.min_stock_alert || 0)
      }))
    });
  } catch (err) {
    console.error('Dashboard report failed:', err.message);
    res.status(500).json({ error: 'Unable to load dashboard report.' });
  }
});

router.get('/daily-sales', authorize('SERVER', 'ADMIN'), async (req, res) => {
  try {
    const from = normalizeDate(req.query.from || req.query.date);
    const to = normalizeDate(req.query.to || from, from);
    const counter = normalizeCounter(req.query.counter);
    const values = [from, to];
    let counterSql = '';

    if (counter) {
      counterSql = 'AND i.billing_counter = ?';
      values.push(counter);
    }

    const [rows] = await db.query(
      `SELECT
         i.invoice_no,
         DATE_FORMAT(i.created_at, '%d-%m-%Y') AS bill_date,
         TIME_FORMAT(i.created_at, '%H:%i') AS bill_time,
         i.customer_name,
         COALESCE(item_counts.item_count, 0) AS item_count,
         i.sub_total,
         i.gst_total,
         i.grand_total,
         i.payment_mode,
         i.billing_counter,
         i.created_at
       FROM invoices i
       LEFT JOIN (
         SELECT invoice_no, COUNT(*) AS item_count
         FROM invoice_items
         GROUP BY invoice_no
       ) item_counts ON item_counts.invoice_no = i.invoice_no
       WHERE DATE(i.created_at) BETWEEN ? AND ?
       ${counterSql}
       ORDER BY i.created_at DESC`,
      values
    );

    const totals = rows.reduce((acc, row) => ({
      billCount: acc.billCount + 1,
      itemCount: acc.itemCount + Number(row.item_count || 0),
      taxable: acc.taxable + Number(row.sub_total || 0),
      gst: acc.gst + Number(row.gst_total || 0),
      total: acc.total + Number(row.grand_total || 0)
    }), { billCount: 0, itemCount: 0, taxable: 0, gst: 0, total: 0 });

    res.json({ from, to, counter: counter || 'ALL', rows, totals });
  } catch (err) {
    console.error('Daily sales report failed:', err.message);
    res.status(500).json({ error: 'Unable to load daily sales report.' });
  }
});

router.get('/daily-sales/export', authorize('SERVER', 'ADMIN'), async (req, res) => {
  try {
    const from = normalizeDate(req.query.from || req.query.date);
    const to = normalizeDate(req.query.to || from, from);
    const counter = normalizeCounter(req.query.counter);
    const { rows, totals } = await getDailySalesForExport(from, to, counter);
    const headers = ['invoice_no', 'date', 'time', 'customer', 'items', 'taxable', 'gst', 'total', 'payment_mode', 'counter'];
    const csv = [
      csvLine(headers),
      ...rows.map((row) => csvLine([
        row.invoice_no,
        row.bill_date,
        row.bill_time,
        row.customer_name,
        row.item_count,
        row.sub_total,
        row.gst_total,
        row.grand_total,
        row.payment_mode,
        row.billing_counter
      ])),
      '',
      csvLine(['TOTAL', '', '', '', totals.itemCount, totals.taxable, totals.gst, totals.total, '', counter || 'ALL'])
    ].join('\n');

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="badizo_daily_sales_${from}_to_${to}.csv"`);
    res.send(csv);
  } catch (err) {
    console.error('Daily sales export failed:', err.message);
    res.status(500).json({ error: 'Unable to export daily sales report.' });
  }
});

async function getDailySalesForExport(from, to, counter) {
  const values = [from, to];
  let counterSql = '';
  if (counter) {
    counterSql = 'AND i.billing_counter = ?';
    values.push(counter);
  }

  const [rows] = await db.query(
    `SELECT
       i.invoice_no,
       DATE_FORMAT(i.created_at, '%d-%m-%Y') AS bill_date,
       TIME_FORMAT(i.created_at, '%H:%i') AS bill_time,
       i.customer_name,
       COALESCE(item_counts.item_count, 0) AS item_count,
       i.sub_total,
       i.gst_total,
       i.grand_total,
       i.payment_mode,
       i.billing_counter,
       i.created_at
     FROM invoices i
     LEFT JOIN (
       SELECT invoice_no, COUNT(*) AS item_count
       FROM invoice_items
       GROUP BY invoice_no
     ) item_counts ON item_counts.invoice_no = i.invoice_no
     WHERE DATE(i.created_at) BETWEEN ? AND ?
     ${counterSql}
     ORDER BY i.created_at DESC`,
    values
  );

  const totals = rows.reduce((acc, row) => ({
    billCount: acc.billCount + 1,
    itemCount: acc.itemCount + Number(row.item_count || 0),
    taxable: acc.taxable + Number(row.sub_total || 0),
    gst: acc.gst + Number(row.gst_total || 0),
    total: acc.total + Number(row.grand_total || 0)
  }), { billCount: 0, itemCount: 0, taxable: 0, gst: 0, total: 0 });

  return { rows, totals };
}

router.get('/gst-hsn', authorize('SERVER', 'ADMIN'), async (req, res) => {
  try {
    const from = normalizeDate(req.query.from, todayIso());
    const to = normalizeDate(req.query.to, from);
    const [rows] = await db.query(
      `SELECT
         COALESCE(p.hsn_code, '') AS hsn_code,
         ii.gst_percent,
         SUM(ii.quantity) AS quantity,
         SUM(ii.quantity * ii.sale_price) AS gross_total,
         SUM(ii.cgst_amount) AS cgst,
         SUM(ii.sgst_amount) AS sgst,
         SUM(ii.igst_amount) AS igst
       FROM invoice_items ii
       INNER JOIN invoices i ON i.invoice_no = ii.invoice_no
       LEFT JOIN products p ON p.barcode = ii.barcode
       WHERE DATE(i.created_at) BETWEEN ? AND ?
       GROUP BY COALESCE(p.hsn_code, ''), ii.gst_percent
       ORDER BY hsn_code ASC, ii.gst_percent ASC`,
      [from, to]
    );

    res.json({ from, to, rows });
  } catch (err) {
    console.error('GST HSN report failed:', err.message);
    res.status(500).json({ error: 'Unable to load GST HSN report.' });
  }
});

router.get('/monthly-sales', authorize('SERVER', 'ADMIN'), async (req, res) => {
  try {
    const month = String(req.query.month || todayIso().slice(0, 7));
    const safeMonth = /^\d{4}-\d{2}$/.test(month) ? month : todayIso().slice(0, 7);
    const [rows] = await db.query(
      `SELECT DATE(created_at) AS sale_date,
              COUNT(*) AS bill_count,
              COALESCE(SUM(sub_total), 0) AS taxable,
              COALESCE(SUM(gst_total), 0) AS gst,
              COALESCE(SUM(grand_total), 0) AS total
       FROM invoices
       WHERE DATE_FORMAT(created_at, '%Y-%m') = ? AND invoice_status <> 'CANCELLED'
       GROUP BY DATE(created_at)
       ORDER BY sale_date ASC`,
      [safeMonth]
    );
    res.json({ month: safeMonth, rows });
  } catch (err) {
    console.error('Monthly sales report failed:', err.message);
    res.status(500).json({ error: 'Unable to load monthly sales report.' });
  }
});

router.get('/stock', authorize('SERVER', 'ADMIN'), async (req, res) => {
  try {
    const lowOnly = String(req.query.low_only || '') === '1';
    const whereSql = lowOnly ? 'WHERE stock_qty <= min_stock_alert' : '';
    const [rows] = await db.query(
      `SELECT barcode, product_code, product_name, hsn_code, gst_percent, purchase_price, sale_price, stock_qty, min_stock_alert,
              stock_qty * purchase_price AS stock_value
       FROM products
       ${whereSql}
       ORDER BY product_name ASC
       LIMIT 1000`
    );
    res.json(rows);
  } catch (err) {
    console.error('Stock report failed:', err.message);
    res.status(500).json({ error: 'Unable to load stock report.' });
  }
});

router.get('/top-products', authorize('SERVER', 'ADMIN'), async (req, res) => {
  try {
    const from = normalizeDate(req.query.from, todayIso());
    const to = normalizeDate(req.query.to, from);
    const direction = String(req.query.direction || 'DESC').toUpperCase() === 'ASC' ? 'ASC' : 'DESC';
    const [rows] = await db.query(
      `SELECT ii.barcode, ii.product_name, SUM(ii.quantity) AS quantity, SUM(ii.quantity * ii.sale_price) AS total
       FROM invoice_items ii
       INNER JOIN invoices i ON i.invoice_no = ii.invoice_no
       WHERE DATE(i.created_at) BETWEEN ? AND ? AND i.invoice_status <> 'CANCELLED'
       GROUP BY ii.barcode, ii.product_name
       ORDER BY quantity ${direction}
       LIMIT 50`,
      [from, to]
    );
    res.json({ from, to, rows });
  } catch (err) {
    console.error('Top products report failed:', err.message);
    res.status(500).json({ error: 'Unable to load product movement report.' });
  }
});

router.get('/tax-summary', authorize('SERVER', 'ADMIN'), async (req, res) => {
  try {
    const from = normalizeDate(req.query.from, todayIso());
    const to = normalizeDate(req.query.to, from);
    const [rows] = await db.query(
      `SELECT ii.gst_percent,
              SUM(ii.quantity * ii.sale_price) AS gross_total,
              SUM(ii.cgst_amount) AS cgst,
              SUM(ii.sgst_amount) AS sgst,
              SUM(ii.igst_amount) AS igst
       FROM invoice_items ii
       INNER JOIN invoices i ON i.invoice_no = ii.invoice_no
       WHERE DATE(i.created_at) BETWEEN ? AND ? AND i.invoice_status <> 'CANCELLED'
       GROUP BY ii.gst_percent
       ORDER BY ii.gst_percent ASC`,
      [from, to]
    );
    res.json({ from, to, rows });
  } catch (err) {
    console.error('Tax summary failed:', err.message);
    res.status(500).json({ error: 'Unable to load tax summary.' });
  }
});

router.get('/gstr1', authorize('SERVER', 'ADMIN'), async (req, res) => {
  try {
    const from = normalizeDate(req.query.from, todayIso());
    const to = normalizeDate(req.query.to, from);

    const [b2b] = await db.query(
      `SELECT
         i.customer_gstin,
         COALESCE(i.customer_company_name, i.customer_name, 'Customer') AS customer_name,
         i.invoice_no,
         DATE_FORMAT(i.created_at, '%d-%m-%Y') AS invoice_date,
         i.tax_type,
         ii.gst_percent,
         SUM((ii.quantity * ii.sale_price) - ii.cgst_amount - ii.sgst_amount - ii.igst_amount) AS taxable_value,
         SUM(ii.cgst_amount) AS cgst,
         SUM(ii.sgst_amount) AS sgst,
         SUM(ii.igst_amount) AS igst,
         SUM(ii.quantity * ii.sale_price) AS invoice_value
       FROM invoices i
       INNER JOIN invoice_items ii ON ii.invoice_no = i.invoice_no
       WHERE DATE(i.created_at) BETWEEN ? AND ?
         AND i.invoice_status <> 'CANCELLED'
         AND (i.transaction_type = 'B2B' OR COALESCE(i.customer_gstin, '') <> '')
       GROUP BY i.customer_gstin, customer_name, i.invoice_no, i.created_at, i.tax_type, ii.gst_percent
       ORDER BY i.created_at ASC, i.invoice_no ASC, ii.gst_percent ASC`,
      [from, to]
    );

    const [b2cl] = await db.query(
      `SELECT
         i.invoice_no,
         DATE_FORMAT(i.created_at, '%d-%m-%Y') AS invoice_date,
         COALESCE(i.customer_name, 'Consumer') AS customer_name,
         ii.gst_percent,
         SUM((ii.quantity * ii.sale_price) - ii.cgst_amount - ii.sgst_amount - ii.igst_amount) AS taxable_value,
         SUM(ii.igst_amount) AS igst,
         SUM(ii.quantity * ii.sale_price) AS invoice_value
       FROM invoices i
       INNER JOIN invoice_items ii ON ii.invoice_no = i.invoice_no
       WHERE DATE(i.created_at) BETWEEN ? AND ?
         AND i.invoice_status <> 'CANCELLED'
         AND i.transaction_type <> 'B2B'
         AND COALESCE(i.customer_gstin, '') = ''
         AND i.tax_type = 'INTERSTATE'
         AND i.grand_total > 250000
       GROUP BY i.invoice_no, i.created_at, customer_name, ii.gst_percent
       ORDER BY i.created_at ASC, i.invoice_no ASC, ii.gst_percent ASC`,
      [from, to]
    );

    const [b2c] = await db.query(
      `SELECT
         CASE WHEN i.tax_type = 'INTERSTATE' THEN 'B2CS-INTERSTATE' ELSE 'B2CS-LOCAL' END AS supply_type,
         ii.gst_percent,
         COUNT(DISTINCT i.invoice_no) AS bill_count,
         SUM((ii.quantity * ii.sale_price) - ii.cgst_amount - ii.sgst_amount - ii.igst_amount) AS taxable_value,
         SUM(ii.cgst_amount) AS cgst,
         SUM(ii.sgst_amount) AS sgst,
         SUM(ii.igst_amount) AS igst,
         SUM(ii.quantity * ii.sale_price) AS gross_value
       FROM invoices i
       INNER JOIN invoice_items ii ON ii.invoice_no = i.invoice_no
       WHERE DATE(i.created_at) BETWEEN ? AND ?
         AND i.invoice_status <> 'CANCELLED'
         AND i.transaction_type <> 'B2B'
         AND COALESCE(i.customer_gstin, '') = ''
         AND NOT (i.tax_type = 'INTERSTATE' AND i.grand_total > 250000)
       GROUP BY supply_type, ii.gst_percent
       ORDER BY supply_type ASC, ii.gst_percent ASC`,
      [from, to]
    );

    const [hsn] = await db.query(
      `SELECT
         COALESCE(p.hsn_code, '') AS hsn_code,
         ii.gst_percent,
         SUM(ii.quantity) AS quantity,
         SUM((ii.quantity * ii.sale_price) - ii.cgst_amount - ii.sgst_amount - ii.igst_amount) AS taxable_value,
         SUM(ii.cgst_amount) AS cgst,
         SUM(ii.sgst_amount) AS sgst,
         SUM(ii.igst_amount) AS igst,
         SUM(ii.quantity * ii.sale_price) AS total_value
       FROM invoice_items ii
       INNER JOIN invoices i ON i.invoice_no = ii.invoice_no
       LEFT JOIN products p ON p.barcode = ii.barcode
       WHERE DATE(i.created_at) BETWEEN ? AND ? AND i.invoice_status <> 'CANCELLED'
       GROUP BY COALESCE(p.hsn_code, ''), ii.gst_percent
       ORDER BY hsn_code ASC, ii.gst_percent ASC`,
      [from, to]
    );

    const [hsnB2b] = await db.query(
      `SELECT
         COALESCE(p.hsn_code, '') AS hsn_code,
         ii.gst_percent,
         SUM(ii.quantity) AS quantity,
         SUM((ii.quantity * ii.sale_price) - ii.cgst_amount - ii.sgst_amount - ii.igst_amount) AS taxable_value,
         SUM(ii.cgst_amount) AS cgst,
         SUM(ii.sgst_amount) AS sgst,
         SUM(ii.igst_amount) AS igst,
         SUM(ii.quantity * ii.sale_price) AS total_value
       FROM invoice_items ii
       INNER JOIN invoices i ON i.invoice_no = ii.invoice_no
       LEFT JOIN products p ON p.barcode = ii.barcode
       WHERE DATE(i.created_at) BETWEEN ? AND ?
         AND i.invoice_status <> 'CANCELLED'
         AND (i.transaction_type = 'B2B' OR COALESCE(i.customer_gstin, '') <> '')
       GROUP BY COALESCE(p.hsn_code, ''), ii.gst_percent
       ORDER BY hsn_code ASC, ii.gst_percent ASC`,
      [from, to]
    );

    const [hsnB2c] = await db.query(
      `SELECT
         COALESCE(p.hsn_code, '') AS hsn_code,
         ii.gst_percent,
         SUM(ii.quantity) AS quantity,
         SUM((ii.quantity * ii.sale_price) - ii.cgst_amount - ii.sgst_amount - ii.igst_amount) AS taxable_value,
         SUM(ii.cgst_amount) AS cgst,
         SUM(ii.sgst_amount) AS sgst,
         SUM(ii.igst_amount) AS igst,
         SUM(ii.quantity * ii.sale_price) AS total_value
       FROM invoice_items ii
       INNER JOIN invoices i ON i.invoice_no = ii.invoice_no
       LEFT JOIN products p ON p.barcode = ii.barcode
       WHERE DATE(i.created_at) BETWEEN ? AND ?
         AND i.invoice_status <> 'CANCELLED'
         AND i.transaction_type <> 'B2B'
         AND COALESCE(i.customer_gstin, '') = ''
       GROUP BY COALESCE(p.hsn_code, ''), ii.gst_percent
       ORDER BY hsn_code ASC, ii.gst_percent ASC`,
      [from, to]
    );

    const [nilExempt] = await db.query(
      `SELECT
         CASE WHEN i.transaction_type = 'B2B' OR COALESCE(i.customer_gstin, '') <> '' THEN 'Registered' ELSE 'Unregistered' END AS supply_type,
         SUM(ii.quantity * ii.sale_price) AS nil_rated_value
       FROM invoices i
       INNER JOIN invoice_items ii ON ii.invoice_no = i.invoice_no
       WHERE DATE(i.created_at) BETWEEN ? AND ?
         AND i.invoice_status <> 'CANCELLED'
         AND ii.gst_percent = 0
       GROUP BY supply_type
       ORDER BY supply_type ASC`,
      [from, to]
    );

    const [documents] = await db.query(
      `SELECT
         COUNT(*) AS issued_count,
         SUM(CASE WHEN invoice_status = 'CANCELLED' THEN 1 ELSE 0 END) AS cancelled_count,
         MIN(invoice_no) AS from_invoice,
         MAX(invoice_no) AS to_invoice
       FROM invoices
       WHERE DATE(created_at) BETWEEN ? AND ?`,
      [from, to]
    );

    const totals = [...b2b, ...b2cl, ...b2c].reduce((acc, row) => ({
      taxable: acc.taxable + Number(row.taxable_value || 0),
      cgst: acc.cgst + Number(row.cgst || 0),
      sgst: acc.sgst + Number(row.sgst || 0),
      igst: acc.igst + Number(row.igst || 0),
      total: acc.total + Number(row.invoice_value || row.gross_value || 0)
    }), { taxable: 0, cgst: 0, sgst: 0, igst: 0, total: 0 });

    res.json({
      from,
      to,
      b2b,
      b2cl,
      b2c,
      hsn,
      hsnB2b,
      hsnB2c,
      nilExempt,
      documents: {
        ...documents[0],
        netIssued: Number(documents[0]?.issued_count || 0) - Number(documents[0]?.cancelled_count || 0)
      },
      totals
    });
  } catch (err) {
    console.error('GSTR-1 report failed:', err.message);
    res.status(500).json({ error: 'Unable to load GSTR-1 report.' });
  }
});

router.get('/exceptions', authorize('SERVER', 'ADMIN'), async (req, res) => {
  try {
    const from = normalizeDate(req.query.from, todayIso());
    const to = normalizeDate(req.query.to, from);
    const [cancelled] = await db.query(
      `SELECT invoice_no, customer_name, grand_total, cancel_reason, cancelled_by, cancelled_at
       FROM invoices
       WHERE DATE(created_at) BETWEEN ? AND ? AND invoice_status = 'CANCELLED'
       ORDER BY cancelled_at DESC`,
      [from, to]
    );
    const [returns] = await db.query(
      `SELECT return_no, invoice_no, reason, refund_mode, refund_total, created_by, created_at
       FROM sales_returns
       WHERE DATE(created_at) BETWEEN ? AND ?
       ORDER BY created_at DESC`,
      [from, to]
    );
    res.json({ from, to, cancelled, returns });
  } catch (err) {
    console.error('Exception report failed:', err.message);
    res.status(500).json({ error: 'Unable to load exception report.' });
  }
});

module.exports = router;
