const express = require('express');
const router = express.Router();
const db = require('../config/db');
const { authenticate, authorize } = require('../middleware/auth');
const { csvLine, normalizeDate, todayIso } = require('../utils/formatters');

function normalizeCounter(value) {
  const text = String(value || '').trim();
  return /^Counter \d+$/.test(text) ? text : '';
}

function normalizeCounterNoFromLabel(value) {
  const text = String(value || '').trim();
  const match = text.match(/^Counter\s+(\d+)$/i);
  return match ? Number.parseInt(match[1], 10) : 0;
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

function dateRangeBounds(from, to = from) {
  const start = from <= to ? from : to;
  const end = from <= to ? to : from;
  return { start, end, nextEnd: nextIsoDate(end) };
}

router.use(authenticate);

router.get('/dashboard', authorize('SERVER', 'ADMIN'), async (_req, res) => {
  try {
    const date = todayIso();
    const nextDate = nextIsoDate(date);
    const [todayRows] = await db.query(
      `SELECT
         COUNT(*) AS bill_count,
         COALESCE(SUM(grand_total), 0) AS sales_total,
         COALESCE(SUM(gst_total), 0) AS gst_total,
         COALESCE(AVG(grand_total), 0) AS average_bill
       FROM invoices
       WHERE created_at >= ? AND created_at < ?
         AND invoice_status <> 'CANCELLED'`,
      [date, nextDate]
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
       WHERE created_at >= ? AND created_at < ?
         AND invoice_status <> 'CANCELLED'
       GROUP BY billing_counter
       ORDER BY billing_counter ASC`,
      [date, nextDate]
    );

    const [paymentRows] = await db.query(
      `SELECT payment_mode, COALESCE(SUM(amount), 0) AS sales_total
       FROM (
         SELECT ip.invoice_no, ip.payment_mode, ip.amount
         FROM invoice_payments ip
         INNER JOIN invoices i ON i.invoice_no = ip.invoice_no
         WHERE DATE(i.created_at) = ?
           AND i.invoice_status <> 'CANCELLED'
         UNION ALL
         SELECT i.invoice_no, i.payment_mode, i.grand_total AS amount
         FROM invoices i
         LEFT JOIN invoice_payments ip ON ip.invoice_no = i.invoice_no
         WHERE DATE(i.created_at) = ?
           AND i.invoice_status <> 'CANCELLED'
           AND ip.id IS NULL
       ) payments
       GROUP BY payment_mode`,
      [date, date]
    );

    const [topProductRows] = await db.query(
      `SELECT ii.product_name, SUM(ii.quantity) AS quantity, SUM(ii.quantity * ii.sale_price) AS sales_total
       FROM invoice_items ii
       INNER JOIN invoices i ON i.invoice_no = ii.invoice_no
       WHERE DATE(i.created_at) = ?
         AND i.invoice_status <> 'CANCELLED'
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
         i.exchange_total,
         (i.sub_total + i.gst_total) AS sale_total,
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
       AND i.invoice_status <> 'CANCELLED'
       ${counterSql}
       ORDER BY i.created_at DESC`,
      values
    );

    const totals = rows.reduce((acc, row) => ({
      billCount: acc.billCount + 1,
      itemCount: acc.itemCount + Number(row.item_count || 0),
      taxable: acc.taxable + Number(row.sub_total || 0),
      gst: acc.gst + Number(row.gst_total || 0),
      saleTotal: acc.saleTotal + Number(row.sale_total || 0),
      total: acc.total + Number(row.grand_total || 0),
      exchangeBillCount: acc.exchangeBillCount + (Number(row.exchange_total || 0) > 0 ? 1 : 0),
      exchangeSaleTotal: acc.exchangeSaleTotal + (Number(row.exchange_total || 0) > 0 ? Number(row.sale_total || 0) : 0),
      exchangeLess: acc.exchangeLess + Number(row.exchange_total || 0),
      exchangeNetTotal: acc.exchangeNetTotal + (Number(row.exchange_total || 0) > 0 ? Number(row.grand_total || 0) : 0)
    }), { billCount: 0, itemCount: 0, taxable: 0, gst: 0, saleTotal: 0, total: 0, exchangeBillCount: 0, exchangeSaleTotal: 0, exchangeLess: 0, exchangeNetTotal: 0 });

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
    const headers = ['invoice_no', 'date', 'time', 'customer', 'items', 'taxable', 'gst', 'sale_total', 'exchange_less', 'net_total', 'payment_mode', 'counter'];
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
        row.sale_total,
        row.exchange_total,
        row.grand_total,
        row.payment_mode,
        row.billing_counter
      ])),
      '',
      csvLine(['TOTAL', '', '', '', totals.itemCount, totals.taxable, totals.gst, totals.saleTotal, totals.exchangeLess, totals.total, '', counter || 'ALL']),
      csvLine(['EXCHANGE BILLS', '', '', '', totals.exchangeBillCount, '', '', totals.exchangeSaleTotal, totals.exchangeLess, totals.exchangeNetTotal, '', counter || 'ALL'])
    ].join('\n');

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="badizo_daily_sales_${from}_to_${to}.csv"`);
    res.send(csv);
  } catch (err) {
    console.error('Daily sales export failed:', err.message);
    res.status(500).json({ error: 'Unable to export daily sales report.' });
  }
});

router.get('/reprints', authorize('SERVER', 'ADMIN'), async (req, res) => {
  try {
    const from = normalizeDate(req.query.from);
    const to = normalizeDate(req.query.to, from);
    const counter = normalizeCounter(req.query.counter);
    const search = String(req.query.search || '').trim();
    const values = [from, to];
    const filters = ['DATE(al.created_at) BETWEEN ? AND ?'];

    if (counter) {
      filters.push('i.billing_counter = ?');
      values.push(counter);
    }

    if (search) {
      filters.push(`(
        al.entity_id LIKE ?
        OR i.customer_name LIKE ?
        OR al.username LIKE ?
        OR COALESCE(JSON_UNQUOTE(JSON_EXTRACT(al.details, '$.print_mode')), 'Thermal') LIKE ?
      )`);
      const like = `%${search}%`;
      values.push(like, like, like, like);
    }

    const [rows] = await db.query(
      `SELECT
         al.id,
         al.entity_id AS invoice_no,
         DATE_FORMAT(al.created_at, '%d-%m-%Y') AS reprint_date,
         TIME_FORMAT(al.created_at, '%H:%i:%s') AS reprint_time,
         al.created_at,
         al.username AS reprinted_by,
         COALESCE(JSON_UNQUOTE(JSON_EXTRACT(al.details, '$.print_mode')), 'Thermal') AS print_mode,
         i.customer_name,
         i.grand_total,
         i.payment_mode,
         i.billing_counter,
         i.created_at AS invoice_created_at,
         i.reprint_count
       FROM audit_logs al
       LEFT JOIN invoices i ON i.invoice_no = al.entity_id
       WHERE al.action = 'INVOICE_REPRINTED'
         AND al.entity_type = 'INVOICE'
         AND ${filters.join(' AND ')}
       ORDER BY al.created_at DESC, al.id DESC`,
      values
    );

    const totals = rows.reduce((acc, row) => {
      const mode = row.print_mode === 'A4' ? 'A4' : 'Thermal';
      return {
        count: acc.count + 1,
        thermal: acc.thermal + (mode === 'Thermal' ? 1 : 0),
        a4: acc.a4 + (mode === 'A4' ? 1 : 0)
      };
    }, { count: 0, thermal: 0, a4: 0 });

    res.json({ from, to, counter: counter || 'ALL', rows, totals });
  } catch (err) {
    console.error('Reprint report failed:', err.message);
    res.status(500).json({ error: 'Unable to load reprint report.' });
  }
});

router.get('/counter-sale-slip', authorize('SERVER', 'ADMIN', 'COUNTER'), async (req, res) => {
  try {
    const date = normalizeDate(req.query.date, todayIso());
    const requestedCounter = normalizeCounterNoFromLabel(req.query.counter)
      || Number.parseInt(req.query.counter_no ?? req.query.counterNo, 10)
      || 0;
    const userCounter = Number.parseInt(req.user?.counter_no, 10) || 0;
    const counterNo = req.user?.role === 'COUNTER' && userCounter > 0
      ? userCounter
      : requestedCounter || userCounter || 1;

    const [counterRows] = await db.query(
      `SELECT
         payment_mode,
         COUNT(DISTINCT invoice_no) AS bill_count,
         COALESCE(SUM(amount), 0) AS total
       FROM (
         SELECT ip.invoice_no, ip.payment_mode, ip.amount
         FROM invoice_payments ip
         INNER JOIN invoices i ON i.invoice_no = ip.invoice_no
          WHERE DATE(i.created_at) = ?
            AND i.billing_counter = ?
            AND i.invoice_status <> 'CANCELLED'
         UNION ALL
         SELECT i.invoice_no, i.payment_mode, i.grand_total AS amount
         FROM invoices i
         LEFT JOIN invoice_payments ip ON ip.invoice_no = i.invoice_no
          WHERE DATE(i.created_at) = ?
            AND i.billing_counter = ?
            AND i.invoice_status <> 'CANCELLED'
            AND ip.id IS NULL
       ) payments
       GROUP BY payment_mode`,
      [date, `Counter ${counterNo}`, date, `Counter ${counterNo}`]
    );

    const [counterBillRows] = await db.query(
      `SELECT COUNT(*) AS bill_count,
              COALESCE(SUM(CASE WHEN exchange_total > 0 THEN 1 ELSE 0 END), 0) AS exchange_bill_count,
              COALESCE(SUM(CASE WHEN exchange_total > 0 THEN sub_total + gst_total ELSE 0 END), 0) AS exchange_sale_total,
              COALESCE(SUM(exchange_total), 0) AS exchange_less,
              COALESCE(SUM(CASE WHEN exchange_total > 0 THEN grand_total ELSE 0 END), 0) AS exchange_net_total
       FROM invoices
        WHERE DATE(created_at) = ?
          AND billing_counter = ?
          AND invoice_status <> 'CANCELLED'`,
      [date, `Counter ${counterNo}`]
    );

    const [allRows] = await db.query(
      `SELECT
         payment_mode,
         COUNT(DISTINCT invoice_no) AS bill_count,
         COALESCE(SUM(amount), 0) AS total
       FROM (
         SELECT ip.invoice_no, ip.payment_mode, ip.amount
         FROM invoice_payments ip
         INNER JOIN invoices i ON i.invoice_no = ip.invoice_no
          WHERE DATE(i.created_at) = ?
            AND i.invoice_status <> 'CANCELLED'
         UNION ALL
         SELECT i.invoice_no, i.payment_mode, i.grand_total AS amount
         FROM invoices i
         LEFT JOIN invoice_payments ip ON ip.invoice_no = i.invoice_no
          WHERE DATE(i.created_at) = ?
            AND i.invoice_status <> 'CANCELLED'
            AND ip.id IS NULL
       ) payments
       GROUP BY payment_mode`,
      [date, date]
    );

    const [allBillRows] = await db.query(
      `SELECT COUNT(*) AS bill_count,
              COALESCE(SUM(CASE WHEN exchange_total > 0 THEN 1 ELSE 0 END), 0) AS exchange_bill_count,
              COALESCE(SUM(CASE WHEN exchange_total > 0 THEN sub_total + gst_total ELSE 0 END), 0) AS exchange_sale_total,
              COALESCE(SUM(exchange_total), 0) AS exchange_less,
              COALESCE(SUM(CASE WHEN exchange_total > 0 THEN grand_total ELSE 0 END), 0) AS exchange_net_total
       FROM invoices
        WHERE DATE(created_at) = ?
          AND invoice_status <> 'CANCELLED'`,
      [date]
    );

    const normalizePaymentTotals = (rows) => {
      const summary = {
        cashSale: 0,
        upiSale: 0,
        cardSale: 0,
        totalSale: 0,
        billCount: 0
      };

      rows.forEach((row) => {
        const mode = String(row.payment_mode || '').toUpperCase();
        const total = Number(row.total || 0);
        if (mode === 'UPI') summary.upiSale += total;
        else if (mode === 'CARD') summary.cardSale += total;
        else summary.cashSale += total;
        summary.totalSale += total;
        summary.billCount += Number(row.bill_count || 0);
      });

      return summary;
    };

    const counterTotals = normalizePaymentTotals(counterRows);
    counterTotals.billCount = Number(counterBillRows[0]?.bill_count || 0);
    counterTotals.exchangeBillCount = Number(counterBillRows[0]?.exchange_bill_count || 0);
    counterTotals.exchangeSaleTotal = Number(counterBillRows[0]?.exchange_sale_total || 0);
    counterTotals.exchangeLess = Number(counterBillRows[0]?.exchange_less || 0);
    counterTotals.exchangeNetTotal = Number(counterBillRows[0]?.exchange_net_total || 0);
    const allTotals = normalizePaymentTotals(allRows);
    allTotals.billCount = Number(allBillRows[0]?.bill_count || 0);
    allTotals.exchangeBillCount = Number(allBillRows[0]?.exchange_bill_count || 0);
    allTotals.exchangeSaleTotal = Number(allBillRows[0]?.exchange_sale_total || 0);
    allTotals.exchangeLess = Number(allBillRows[0]?.exchange_less || 0);
    allTotals.exchangeNetTotal = Number(allBillRows[0]?.exchange_net_total || 0);

    res.json({
      date,
      counterNo,
      counter: counterTotals,
      allCounters: allTotals
    });
  } catch (err) {
    console.error('Counter sale slip failed:', err.message);
    res.status(500).json({ error: 'Unable to load counter sale slip.' });
  }
});

router.get('/pos-sale-report', authorize('SERVER', 'ADMIN', 'COUNTER'), async (req, res) => {
  try {
    const from = normalizeDate(req.query.from || req.query.date, todayIso());
    const to = normalizeDate(req.query.to || from, from);
    const { start, end, nextEnd } = dateRangeBounds(from, to);
    const reportType = String(req.query.report_type || 'ALL').toUpperCase() === 'GST' ? 'GST' : 'ALL';
    const requestedCounter = normalizeCounterNoFromLabel(req.query.counter) || Number.parseInt(req.query.counter_no, 10) || 0;
    const counterNo = requestedCounter >= 1 && requestedCounter <= 6 ? requestedCounter : 0;
    const counter = counterNo > 0 ? `Counter ${counterNo}` : '';
    const paymentValues = [start, nextEnd];
    const invoiceValues = [start, nextEnd];
    const gstValues = [start, nextEnd];
    let counterSql = '';

    if (counter) {
      counterSql = 'AND i.billing_counter = ?';
      paymentValues.push(counter);
      invoiceValues.push(counter);
      gstValues.push(counter);
    }

    const [paymentRows] = await db.query(
      `SELECT payment_mode, COALESCE(SUM(amount), 0) AS total
       FROM (
         SELECT ip.invoice_no, ip.payment_mode, ip.amount
         FROM invoice_payments ip
         INNER JOIN invoices i ON i.invoice_no = ip.invoice_no
         WHERE i.created_at >= ? AND i.created_at < ?
           AND i.invoice_status <> 'CANCELLED'
           ${counterSql}
         UNION ALL
         SELECT i.invoice_no, i.payment_mode, i.grand_total AS amount
         FROM invoices i
         LEFT JOIN invoice_payments ip ON ip.invoice_no = i.invoice_no
         WHERE i.created_at >= ? AND i.created_at < ?
           AND i.invoice_status <> 'CANCELLED'
           AND ip.id IS NULL
           ${counterSql}
       ) payments
       GROUP BY payment_mode`,
      counter ? [...paymentValues, ...paymentValues] : [start, nextEnd, start, nextEnd]
    );

    const [invoiceRows] = await db.query(
      `SELECT
         COUNT(*) AS bill_count,
         COALESCE(SUM(sub_total), 0) AS taxable_total,
         COALESCE(SUM(gst_total), 0) AS gst_total,
         COALESCE(SUM(sub_total + gst_total), 0) AS sale_total,
         COALESCE(SUM(exchange_total), 0) AS exchange_total,
         COALESCE(SUM(grand_total), 0) AS net_total,
         COALESCE(SUM(CASE WHEN exchange_total > 0 THEN 1 ELSE 0 END), 0) AS exchange_bill_count,
         COALESCE(SUM(CASE WHEN exchange_total > 0 THEN sub_total + gst_total ELSE 0 END), 0) AS exchange_sale_total,
         COALESCE(SUM(CASE WHEN exchange_total > 0 THEN grand_total ELSE 0 END), 0) AS exchange_net_total
       FROM invoices i
       WHERE i.created_at >= ? AND i.created_at < ?
         AND i.invoice_status <> 'CANCELLED'
         ${counterSql}`,
      invoiceValues
    );

    const [billRangeRows] = await db.query(
      `SELECT
         (
           SELECT first_bill.invoice_no
           FROM invoices first_bill
           WHERE first_bill.created_at >= ? AND first_bill.created_at < ?
             AND first_bill.invoice_status <> 'CANCELLED'
             ${counter ? 'AND first_bill.billing_counter = ?' : ''}
           ORDER BY first_bill.created_at ASC, first_bill.id ASC
           LIMIT 1
         ) AS starting_invoice_no,
         (
           SELECT last_bill.invoice_no
           FROM invoices last_bill
           WHERE last_bill.created_at >= ? AND last_bill.created_at < ?
             AND last_bill.invoice_status <> 'CANCELLED'
             ${counter ? 'AND last_bill.billing_counter = ?' : ''}
           ORDER BY last_bill.created_at DESC, last_bill.id DESC
           LIMIT 1
         ) AS ending_invoice_no`,
      counter ? [start, nextEnd, counter, start, nextEnd, counter] : [start, nextEnd, start, nextEnd]
    );

    const [gstRows] = await db.query(
      `SELECT
         ii.gst_percent,
         COUNT(DISTINCT i.invoice_no) AS bill_count,
         COALESCE(SUM(ii.quantity), 0) AS quantity,
         COALESCE(SUM((ii.sale_price * ii.quantity) - ii.cgst_amount - ii.sgst_amount - ii.igst_amount), 0) AS taxable,
         COALESCE(SUM(ii.cgst_amount), 0) AS cgst,
         COALESCE(SUM(ii.sgst_amount), 0) AS sgst,
         COALESCE(SUM(ii.igst_amount), 0) AS igst,
         COALESCE(SUM(ii.sale_price * ii.quantity), 0) AS total
       FROM invoice_items ii
       INNER JOIN invoices i ON i.invoice_no = ii.invoice_no
       WHERE i.created_at >= ? AND i.created_at < ?
         AND i.invoice_status <> 'CANCELLED'
         ${counterSql}
       GROUP BY ii.gst_percent
       ORDER BY ii.gst_percent ASC`,
      gstValues
    );

    const paymentTotals = {
      cash: 0,
      upi: 0,
      card: 0,
      other: 0,
      total: 0
    };

    paymentRows.forEach((row) => {
      const mode = String(row.payment_mode || '').toUpperCase();
      const total = Number(row.total || 0);
      if (mode === 'UPI') paymentTotals.upi += total;
      else if (mode === 'CARD') paymentTotals.card += total;
      else if (mode === 'CASH') paymentTotals.cash += total;
      else paymentTotals.other += total;
      paymentTotals.total += total;
    });

    const baseGstSlabs = [0, 3, 5, 12, 18, 28, 40];
    const rowsByRate = new Map(gstRows.map((row) => [Number(row.gst_percent || 0), row]));
    const allRates = [...new Set([...baseGstSlabs, ...gstRows.map((row) => Number(row.gst_percent || 0))])]
      .sort((a, b) => a - b);
    const gst = allRates.map((rate) => {
      const row = rowsByRate.get(rate) || {};
      const cgst = Number(row.cgst || 0);
      const sgst = Number(row.sgst || 0);
      const igst = Number(row.igst || 0);
      return {
        gstPercent: rate,
        billCount: Number(row.bill_count || 0),
        quantity: Number(row.quantity || 0),
        taxable: Number(row.taxable || 0),
        cgst,
        sgst,
        igst,
        gst: cgst + sgst + igst,
        total: Number(row.total || 0)
      };
    });

    const totals = {
      billCount: Number(invoiceRows[0]?.bill_count || 0),
      startingInvoiceNo: billRangeRows[0]?.starting_invoice_no || '',
      endingInvoiceNo: billRangeRows[0]?.ending_invoice_no || '',
      taxable: Number(invoiceRows[0]?.taxable_total || 0),
      gst: Number(invoiceRows[0]?.gst_total || 0),
      saleTotal: Number(invoiceRows[0]?.sale_total || 0),
      exchangeTotal: Number(invoiceRows[0]?.exchange_total || 0),
      exchangeBillCount: Number(invoiceRows[0]?.exchange_bill_count || 0),
      exchangeSaleTotal: Number(invoiceRows[0]?.exchange_sale_total || 0),
      exchangeNetTotal: Number(invoiceRows[0]?.exchange_net_total || 0),
      netTotal: Number(invoiceRows[0]?.net_total || 0)
    };

    res.json({
      from,
      to,
      reportType,
      counter: counter || 'ALL',
      paymentTotals,
      gst,
      totals
    });
  } catch (err) {
    console.error('POS sale report failed:', err.message);
    res.status(500).json({ error: 'Unable to load POS sale report.' });
  }
});

router.get('/counter-handover', authorize('SERVER', 'ADMIN'), async (req, res) => {
  try {
    const from = normalizeDate(req.query.from || req.query.date);
    const to = normalizeDate(req.query.to || from, from);
    const counterNo = normalizeCounterNoFromLabel(req.query.counter);
    const values = [from, to];
    let counterSql = '';

    if (counterNo > 0) {
      counterSql = 'AND counter_no = ?';
      values.push(counterNo);
    }

    const [rows] = await db.query(
      `SELECT
         id,
         closing_date,
         counter_no,
         sheet_no,
         opening_cash,
         counter_sales,
         all_counter_sales,
         cash_sales,
         upi_sales,
         card_sales,
         dr_total,
         cr_total,
         notes_total,
         cash_balance,
         variance_amount,
         handed_over_by,
         taken_over_by,
         updated_at
       FROM counter_handover_sheets
       WHERE closing_date BETWEEN ? AND ?
       ${counterSql}
       ORDER BY closing_date DESC, counter_no ASC`,
      values
    );

    let entryRows = [];
    let denominationRows = [];
    if (rows.length) {
      const sheetIds = rows.map((row) => row.id);
      [entryRows] = await db.query(
        `SELECT sheet_id, line_no, entry_type, details, remarks, direction, amount
         FROM counter_handover_entries
         WHERE sheet_id IN (?)
         ORDER BY sheet_id ASC, line_no ASC, id ASC`,
        [sheetIds]
      );
      [denominationRows] = await db.query(
        `SELECT sheet_id, denomination_label, denomination_value, quantity, amount
         FROM counter_handover_denominations
         WHERE sheet_id IN (?)
         ORDER BY sheet_id ASC, denomination_value DESC`,
        [sheetIds]
      );
    }

    const entriesBySheet = entryRows.reduce((acc, row) => {
      const key = Number(row.sheet_id);
      if (!acc[key]) acc[key] = [];
      acc[key].push(row);
      return acc;
    }, {});
    const denominationsBySheet = denominationRows.reduce((acc, row) => {
      const key = Number(row.sheet_id);
      if (!acc[key]) acc[key] = [];
      acc[key].push(row);
      return acc;
    }, {});
    const sheets = rows.map((row) => ({
      ...row,
      entries: entriesBySheet[Number(row.id)] || [],
      denominations: denominationsBySheet[Number(row.id)] || []
    }));

    const totals = rows.reduce((acc, row) => ({
      sheets: acc.sheets + 1,
      counterSales: acc.counterSales + Number(row.counter_sales || 0),
      dr: acc.dr + Number(row.dr_total || 0),
      cr: acc.cr + Number(row.cr_total || 0),
      cashBalance: acc.cashBalance + Number(row.cash_balance || 0),
      difference: acc.difference + Number(row.variance_amount || 0)
    }), { sheets: 0, counterSales: 0, dr: 0, cr: 0, cashBalance: 0, difference: 0 });

    res.json({ from, to, counter: counterNo > 0 ? `Counter ${counterNo}` : 'ALL', rows: sheets, totals });
  } catch (err) {
    console.error('Counter handover report failed:', err.message);
    res.status(500).json({ error: 'Unable to load counter handover report.' });
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
       i.exchange_total,
       (i.sub_total + i.gst_total) AS sale_total,
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
     AND i.invoice_status <> 'CANCELLED'
     ${counterSql}
     ORDER BY i.created_at DESC`,
    values
  );

  const totals = rows.reduce((acc, row) => ({
    billCount: acc.billCount + 1,
    itemCount: acc.itemCount + Number(row.item_count || 0),
    taxable: acc.taxable + Number(row.sub_total || 0),
    gst: acc.gst + Number(row.gst_total || 0),
    saleTotal: acc.saleTotal + Number(row.sale_total || 0),
    exchangeLess: acc.exchangeLess + Number(row.exchange_total || 0),
    total: acc.total + Number(row.grand_total || 0),
    exchangeBillCount: acc.exchangeBillCount + (Number(row.exchange_total || 0) > 0 ? 1 : 0),
    exchangeSaleTotal: acc.exchangeSaleTotal + (Number(row.exchange_total || 0) > 0 ? Number(row.sale_total || 0) : 0),
    exchangeNetTotal: acc.exchangeNetTotal + (Number(row.exchange_total || 0) > 0 ? Number(row.grand_total || 0) : 0)
  }), { billCount: 0, itemCount: 0, taxable: 0, gst: 0, saleTotal: 0, exchangeLess: 0, total: 0, exchangeBillCount: 0, exchangeSaleTotal: 0, exchangeNetTotal: 0 });

  return { rows, totals };
}

router.get('/gst-hsn', authorize('SERVER', 'ADMIN'), async (req, res) => {
  try {
    const from = normalizeDate(req.query.from, todayIso());
    const to = normalizeDate(req.query.to, from);
    const [rows] = await db.query(
       `SELECT
          COALESCE(NULLIF(ii.hsn_code, ''), NULLIF(p.hsn_code, ''), '') AS hsn_code,
          COALESCE(NULLIF(p.product_code, ''), ii.barcode, '') AS product_code,
          COALESCE(NULLIF(ii.product_name, ''), NULLIF(p.product_name, ''), '') AS product_name,
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
         AND i.invoice_status <> 'CANCELLED'
       GROUP BY
         COALESCE(NULLIF(ii.hsn_code, ''), NULLIF(p.hsn_code, ''), ''),
         COALESCE(NULLIF(p.product_code, ''), ii.barcode, ''),
         COALESCE(NULLIF(ii.product_name, ''), NULLIF(p.product_name, ''), ''),
         ii.gst_percent
       ORDER BY hsn_code ASC, ii.gst_percent ASC, product_name ASC`,
      [from, to]
    );

    res.json({ from, to, rows });
  } catch (err) {
    console.error('GST HSN report failed:', err.message);
    res.status(500).json({ error: 'Unable to load GST HSN report.' });
  }
});

router.get('/gst-hsn/product-details', authorize('SERVER', 'ADMIN'), async (req, res) => {
  try {
    const from = normalizeDate(req.query.from, todayIso());
    const to = normalizeDate(req.query.to, from);
    const search = String(req.query.search || '').trim();

    if (!search) {
      return res.json({
        from,
        to,
        search,
        rows: [],
        totals: { quantity: 0, gross: 0, cgst: 0, sgst: 0, igst: 0 }
      });
    }

    const like = `%${search}%`;
    const [rows] = await db.query(
      `SELECT
         DATE_FORMAT(i.created_at, '%Y-%m-%d') AS sale_date,
         TIME_FORMAT(i.created_at, '%H:%i:%s') AS sale_time,
         i.invoice_no,
         i.billing_counter,
         ii.barcode,
         COALESCE(NULLIF(p.product_code, ''), ii.barcode, '') AS product_code,
         COALESCE(NULLIF(ii.product_name, ''), NULLIF(p.product_name, ''), '') AS product_name,
         COALESCE(NULLIF(ii.hsn_code, ''), NULLIF(p.hsn_code, ''), '') AS hsn_code,
         ii.gst_percent,
         ii.quantity,
         ii.sale_price,
         (ii.quantity * ii.sale_price) AS gross_total,
         ii.cgst_amount AS cgst,
         ii.sgst_amount AS sgst,
         ii.igst_amount AS igst
       FROM invoice_items ii
       INNER JOIN invoices i ON i.invoice_no = ii.invoice_no
       LEFT JOIN products p ON p.barcode = ii.barcode
       WHERE DATE(i.created_at) BETWEEN ? AND ?
         AND i.invoice_status <> 'CANCELLED'
         AND (
           ii.barcode LIKE ?
           OR COALESCE(p.product_code, '') LIKE ?
           OR COALESCE(ii.product_name, '') LIKE ?
           OR COALESCE(p.product_name, '') LIKE ?
         )
       ORDER BY i.created_at DESC, i.invoice_no DESC, ii.id DESC
       LIMIT 500`,
      [from, to, like, like, like, like]
    );

    const totals = rows.reduce((acc, row) => ({
      quantity: acc.quantity + Number(row.quantity || 0),
      gross: acc.gross + Number(row.gross_total || 0),
      cgst: acc.cgst + Number(row.cgst || 0),
      sgst: acc.sgst + Number(row.sgst || 0),
      igst: acc.igst + Number(row.igst || 0)
    }), { quantity: 0, gross: 0, cgst: 0, sgst: 0, igst: 0 });

    res.json({ from, to, search, rows, totals });
  } catch (err) {
    console.error('GST HSN product details failed:', err.message);
    res.status(500).json({ error: 'Unable to load GST HSN product details.' });
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

router.get('/exchange-bills', authorize('SERVER', 'ADMIN'), async (req, res) => {
  try {
    const from = normalizeDate(req.query.from, todayIso());
    const to = normalizeDate(req.query.to, from);
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
         i.customer_phone,
         i.payment_mode,
         i.billing_counter,
         i.sub_total,
         i.gst_total,
         (i.sub_total + i.gst_total) AS sale_total,
         i.exchange_total,
         i.grand_total,
         i.cash_received,
         i.change_returned,
         i.exchange_items_json,
         COALESCE(item_counts.item_count, 0) AS item_count,
         COALESCE(exchange_counts.exchange_item_count, 0) AS exchange_item_count
       FROM invoices i
       LEFT JOIN (
         SELECT invoice_no, COUNT(*) AS item_count
         FROM invoice_items
         GROUP BY invoice_no
       ) item_counts ON item_counts.invoice_no = i.invoice_no
       LEFT JOIN (
         SELECT invoice_no, JSON_LENGTH(exchange_items_json) AS exchange_item_count
         FROM invoices
         WHERE exchange_total > 0
       ) exchange_counts ON exchange_counts.invoice_no = i.invoice_no
       WHERE DATE(i.created_at) BETWEEN ? AND ?
         AND i.invoice_status <> 'CANCELLED'
         AND i.exchange_total > 0
       ${counterSql}
       ORDER BY i.created_at DESC`,
      values
    );

    const normalizedRows = rows.map((row) => {
      let exchangeItems = [];
      try {
        exchangeItems = Array.isArray(row.exchange_items_json)
          ? row.exchange_items_json
          : JSON.parse(row.exchange_items_json || '[]');
      } catch (err) {
        exchangeItems = [];
      }
      return {
        ...row,
        exchange_items: exchangeItems,
        exchange_item_count: Number(row.exchange_item_count || exchangeItems.length || 0)
      };
    });

    const totals = normalizedRows.reduce((acc, row) => ({
      billCount: acc.billCount + 1,
      itemCount: acc.itemCount + Number(row.item_count || 0),
      exchangeItemCount: acc.exchangeItemCount + Number(row.exchange_item_count || 0),
      saleTotal: acc.saleTotal + Number(row.sale_total || 0),
      exchangeTotal: acc.exchangeTotal + Number(row.exchange_total || 0),
      netTotal: acc.netTotal + Number(row.grand_total || 0)
    }), { billCount: 0, itemCount: 0, exchangeItemCount: 0, saleTotal: 0, exchangeTotal: 0, netTotal: 0 });

    res.json({ from, to, counter: counter || 'ALL', rows: normalizedRows, totals });
  } catch (err) {
    console.error('Exchange report failed:', err.message);
    res.status(500).json({ error: 'Unable to load exchange bills report.' });
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
         COALESCE(NULLIF(ii.hsn_code, ''), NULLIF(p.hsn_code, ''), '') AS hsn_code,
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
       GROUP BY COALESCE(NULLIF(ii.hsn_code, ''), NULLIF(p.hsn_code, ''), ''), ii.gst_percent
       ORDER BY hsn_code ASC, ii.gst_percent ASC`,
      [from, to]
    );

    const [hsnB2b] = await db.query(
      `SELECT
         COALESCE(NULLIF(ii.hsn_code, ''), NULLIF(p.hsn_code, ''), '') AS hsn_code,
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
       GROUP BY COALESCE(NULLIF(ii.hsn_code, ''), NULLIF(p.hsn_code, ''), ''), ii.gst_percent
       ORDER BY hsn_code ASC, ii.gst_percent ASC`,
      [from, to]
    );

    const [hsnB2c] = await db.query(
      `SELECT
         COALESCE(NULLIF(ii.hsn_code, ''), NULLIF(p.hsn_code, ''), '') AS hsn_code,
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
       GROUP BY COALESCE(NULLIF(ii.hsn_code, ''), NULLIF(p.hsn_code, ''), ''), ii.gst_percent
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

router.get('/gstr2', authorize('SERVER', 'ADMIN'), async (req, res) => {
  try {
    const from = normalizeDate(req.query.from, todayIso());
    const to = normalizeDate(req.query.to, from);

    const [b2b] = await db.query(
      `SELECT
         ie.supplier_gstin,
         ie.supplier_name,
         ie.supplier_invoice_no,
         DATE_FORMAT(COALESCE(ie.supplier_invoice_date, ie.created_at), '%d-%m-%Y') AS invoice_date,
         ie.inward_no,
         ie.tax_type,
         ii.gst_percent,
         SUM(ii.taxable_amount) AS taxable_value,
         SUM(ii.cgst_amount) AS cgst,
         SUM(ii.sgst_amount) AS sgst,
         SUM(ii.igst_amount) AS igst,
         SUM(ii.total_amount) AS invoice_value
       FROM inward_entries ie
       INNER JOIN inward_items ii ON ii.inward_no = ie.inward_no
       WHERE DATE(ie.created_at) BETWEEN ? AND ?
       GROUP BY ie.supplier_gstin, ie.supplier_name, ie.supplier_invoice_no,
                COALESCE(ie.supplier_invoice_date, DATE(ie.created_at)), ie.inward_no, ie.tax_type, ii.gst_percent
       ORDER BY COALESCE(ie.supplier_invoice_date, DATE(ie.created_at)) ASC, ie.inward_no ASC, ii.gst_percent ASC`,
      [from, to]
    );

    const [hsn] = await db.query(
      `SELECT
         COALESCE(NULLIF(ii.hsn_code, ''), NULLIF(p.hsn_code, ''), '') AS hsn_code,
         ii.gst_percent,
         SUM(ii.quantity) AS quantity,
         SUM(ii.taxable_amount) AS taxable_value,
         SUM(ii.cgst_amount) AS cgst,
         SUM(ii.sgst_amount) AS sgst,
         SUM(ii.igst_amount) AS igst,
         SUM(ii.total_amount) AS total_value
       FROM inward_items ii
       INNER JOIN inward_entries ie ON ie.inward_no = ii.inward_no
       LEFT JOIN products p ON p.barcode = ii.barcode
       WHERE DATE(ie.created_at) BETWEEN ? AND ?
       GROUP BY COALESCE(NULLIF(ii.hsn_code, ''), NULLIF(p.hsn_code, ''), ''), ii.gst_percent
       ORDER BY hsn_code ASC, ii.gst_percent ASC`,
      [from, to]
    );

    const totals = b2b.reduce((acc, row) => ({
      taxable: acc.taxable + Number(row.taxable_value || 0),
      cgst: acc.cgst + Number(row.cgst || 0),
      sgst: acc.sgst + Number(row.sgst || 0),
      igst: acc.igst + Number(row.igst || 0),
      total: acc.total + Number(row.invoice_value || 0)
    }), { taxable: 0, cgst: 0, sgst: 0, igst: 0, total: 0 });

    res.json({ from, to, b2b, hsn, totals });
  } catch (err) {
    console.error('GSTR-2 report failed:', err.message);
    res.status(500).json({ error: 'Unable to load GSTR-2 report.' });
  }
});

router.get('/gstr3', authorize('SERVER', 'ADMIN'), async (req, res) => {
  try {
    const from = normalizeDate(req.query.from, todayIso());
    const to = normalizeDate(req.query.to, from);

    const [outward] = await db.query(
      `SELECT
         ii.gst_percent,
         SUM((ii.sale_price * ii.quantity) - ii.cgst_amount - ii.sgst_amount - ii.igst_amount) AS taxable,
         SUM(ii.cgst_amount) AS cgst,
         SUM(ii.sgst_amount) AS sgst,
         SUM(ii.igst_amount) AS igst,
         SUM(ii.cgst_amount + ii.sgst_amount + ii.igst_amount) AS tax,
         SUM(ii.sale_price * ii.quantity) AS total
       FROM invoice_items ii
       INNER JOIN invoices i ON i.invoice_no = ii.invoice_no
       WHERE DATE(i.created_at) BETWEEN ? AND ? AND i.invoice_status <> 'CANCELLED'
       GROUP BY ii.gst_percent
       ORDER BY ii.gst_percent ASC`,
      [from, to]
    );

    const [inward] = await db.query(
      `SELECT
         ii.gst_percent,
         SUM(ii.taxable_amount) AS taxable,
         SUM(ii.cgst_amount) AS cgst,
         SUM(ii.sgst_amount) AS sgst,
         SUM(ii.igst_amount) AS igst,
         SUM(ii.gst_amount) AS tax,
         SUM(ii.total_amount) AS total
       FROM inward_items ii
       INNER JOIN inward_entries ie ON ie.inward_no = ii.inward_no
       WHERE DATE(ie.created_at) BETWEEN ? AND ?
       GROUP BY ii.gst_percent
       ORDER BY ii.gst_percent ASC`,
      [from, to]
    );

    const [threeBOutward] = await db.query(
      `SELECT
         CASE
           WHEN ii.gst_percent = 0 THEN '3.1(c) Nil rated / exempted outward supplies'
           ELSE '3.1(a) Outward taxable supplies'
         END AS section,
         SUM((ii.sale_price * ii.quantity) - ii.cgst_amount - ii.sgst_amount - ii.igst_amount) AS taxable,
         SUM(ii.igst_amount) AS igst,
         SUM(ii.cgst_amount) AS cgst,
         SUM(ii.sgst_amount) AS sgst,
         0 AS cess
       FROM invoice_items ii
       INNER JOIN invoices i ON i.invoice_no = ii.invoice_no
       WHERE DATE(i.created_at) BETWEEN ? AND ? AND i.invoice_status <> 'CANCELLED'
       GROUP BY section
       ORDER BY section ASC`,
      [from, to]
    );

    const [itcSummary] = await db.query(
      `SELECT
         '4(A)(5) All other ITC' AS section,
         SUM(ii.igst_amount) AS igst,
         SUM(ii.cgst_amount) AS cgst,
         SUM(ii.sgst_amount) AS sgst,
         0 AS cess
       FROM inward_items ii
       INNER JOIN inward_entries ie ON ie.inward_no = ii.inward_no
       WHERE DATE(ie.created_at) BETWEEN ? AND ?`,
      [from, to]
    );

    const [missingSalesHsn] = await db.query(
      `SELECT i.invoice_no, ii.barcode, ii.product_name, ii.gst_percent, ii.quantity
       FROM invoice_items ii
       INNER JOIN invoices i ON i.invoice_no = ii.invoice_no
       WHERE DATE(i.created_at) BETWEEN ? AND ?
         AND i.invoice_status <> 'CANCELLED'
         AND COALESCE(ii.hsn_code, '') = ''
       ORDER BY i.created_at ASC, i.invoice_no ASC
       LIMIT 200`,
      [from, to]
    );

    const [missingPurchaseHsn] = await db.query(
      `SELECT ie.inward_no, ii.barcode, ii.product_name, ii.gst_percent, ii.quantity
       FROM inward_items ii
       INNER JOIN inward_entries ie ON ie.inward_no = ii.inward_no
       WHERE DATE(ie.created_at) BETWEEN ? AND ?
         AND COALESCE(ii.hsn_code, '') = ''
       ORDER BY ie.created_at ASC, ie.inward_no ASC
       LIMIT 200`,
      [from, to]
    );

    const [missingB2bGstin] = await db.query(
      `SELECT invoice_no, COALESCE(customer_company_name, customer_name, 'Customer') AS party_name, grand_total, created_at
       FROM invoices
       WHERE DATE(created_at) BETWEEN ? AND ?
         AND invoice_status <> 'CANCELLED'
         AND transaction_type = 'B2B'
         AND COALESCE(customer_gstin, '') = ''
       ORDER BY created_at ASC
       LIMIT 200`,
      [from, to]
    );

    const [missingSupplierGstin] = await db.query(
      `SELECT inward_no, supplier_name, supplier_invoice_no, grand_total, created_at
       FROM inward_entries
       WHERE DATE(created_at) BETWEEN ? AND ?
         AND COALESCE(supplier_gstin, '') = ''
       ORDER BY created_at ASC
       LIMIT 200`,
      [from, to]
    );

    const [salesMismatch] = await db.query(
      `SELECT i.invoice_no, i.sub_total, i.gst_total, i.grand_total,
              SUM((ii.sale_price * ii.quantity) - ii.cgst_amount - ii.sgst_amount - ii.igst_amount) AS item_taxable,
              SUM(ii.cgst_amount + ii.sgst_amount + ii.igst_amount) AS item_gst,
              SUM(ii.sale_price * ii.quantity) AS item_total
       FROM invoices i
       INNER JOIN invoice_items ii ON ii.invoice_no = i.invoice_no
       WHERE DATE(i.created_at) BETWEEN ? AND ? AND i.invoice_status <> 'CANCELLED'
       GROUP BY i.invoice_no, i.sub_total, i.gst_total, i.grand_total
       HAVING ABS(i.sub_total - item_taxable) > 1 OR ABS(i.gst_total - item_gst) > 1 OR ABS(i.grand_total - item_total) > 1
       ORDER BY i.invoice_no ASC
       LIMIT 200`,
      [from, to]
    );

    const [purchaseMismatch] = await db.query(
      `SELECT ie.inward_no, ie.taxable_total, ie.gst_total, ie.grand_total,
              SUM(ii.taxable_amount) AS item_taxable,
              SUM(ii.gst_amount) AS item_gst,
              SUM(ii.total_amount) AS item_total
       FROM inward_entries ie
       INNER JOIN inward_items ii ON ii.inward_no = ie.inward_no
       WHERE DATE(ie.created_at) BETWEEN ? AND ?
       GROUP BY ie.inward_no, ie.taxable_total, ie.gst_total, ie.grand_total
       HAVING ABS(ie.taxable_total - item_taxable) > 1 OR ABS(ie.gst_total - item_gst) > 1 OR ABS(ie.grand_total - item_total) > 1
       ORDER BY ie.inward_no ASC
       LIMIT 200`,
      [from, to]
    );

    const outputTax = outward.reduce((sum, row) => sum + Number(row.tax || 0), 0);
    const inputTax = inward.reduce((sum, row) => sum + Number(row.tax || 0), 0);
    const itc = itcSummary[0] || {};
    const totals = {
      outwardTaxable: outward.reduce((sum, row) => sum + Number(row.taxable || 0), 0),
      outwardTax: outputTax,
      inwardTaxable: inward.reduce((sum, row) => sum + Number(row.taxable || 0), 0),
      inputTax,
      payable: outputTax - inputTax
    };

    res.json({
      from,
      to,
      outward,
      inward,
      threeB: {
        outward: threeBOutward,
        itc: [{
          section: itc.section || '4(A)(5) All other ITC',
          igst: Number(itc.igst || 0),
          cgst: Number(itc.cgst || 0),
          sgst: Number(itc.sgst || 0),
          cess: Number(itc.cess || 0)
        }],
        payment: [{
          description: 'Output tax minus input tax credit',
          outputTax,
          inputTax,
          payable: outputTax - inputTax
        }]
      },
      checks: {
        missingSalesHsn,
        missingPurchaseHsn,
        missingB2bGstin,
        missingSupplierGstin,
        salesMismatch,
        purchaseMismatch
      },
      totals
    });
  } catch (err) {
    console.error('GSTR-3 report failed:', err.message);
    res.status(500).json({ error: 'Unable to load GSTR-3 report.' });
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
