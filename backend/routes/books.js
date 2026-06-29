const express = require('express');
const router = express.Router();
const db = require('../config/db');
const { authenticate, authorize } = require('../middleware/auth');
const { normalizeDate, parseMoney } = require('../utils/formatters');

router.use(authenticate, authorize('SERVER', 'ADMIN'));

const CASH_ACCOUNT_LEDGER = 'Counter Closing Cash Account';
const CASH_ACCOUNT_MANUAL_SOURCE = 'CASH_ACCOUNT_MANUAL';
const COUNTER_CASH_DENOMINATIONS = [2000, 500, 200, 100, 50, 20, 10, 5, 2, 1];

async function hasColumn(tableName, columnName) {
  const [rows] = await db.query(
    `SELECT COLUMN_NAME
     FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?
     LIMIT 1`,
    [tableName, columnName]
  );
  return rows.length > 0;
}

async function hasTable(tableName) {
  const [rows] = await db.query(
    `SELECT TABLE_NAME
     FROM INFORMATION_SCHEMA.TABLES
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?
     LIMIT 1`,
    [tableName]
  );
  return rows.length > 0;
}

function daysBetween(fromValue, toValue) {
  const fromDate = new Date(fromValue);
  const toDate = new Date(toValue);
  if (Number.isNaN(fromDate.getTime()) || Number.isNaN(toDate.getTime())) return 0;
  fromDate.setHours(0, 0, 0, 0);
  toDate.setHours(0, 0, 0, 0);
  return Math.floor((toDate - fromDate) / 86400000);
}

function agingBucket(days) {
  if (days <= 0) return 'Not Due';
  if (days <= 30) return '1-30 Days';
  if (days <= 60) return '31-60 Days';
  if (days <= 90) return '61-90 Days';
  return '90+ Days';
}

function emptyAgingSummary() {
  return {
    accounts: 0,
    bills: 0,
    notDue: 0,
    days1To30: 0,
    days31To60: 0,
    days61To90: 0,
    days90Plus: 0,
    overdue: 0,
    total: 0
  };
}

function addAgingAmount(summary, bucket, amount) {
  if (bucket === 'Not Due') summary.notDue += amount;
  else if (bucket === '1-30 Days') summary.days1To30 += amount;
  else if (bucket === '31-60 Days') summary.days31To60 += amount;
  else if (bucket === '61-90 Days') summary.days61To90 += amount;
  else summary.days90Plus += amount;
  if (bucket !== 'Not Due') summary.overdue += amount;
  summary.total += amount;
}

function formatCashAccountDate(value) {
  if (!value) return '';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return String(value).slice(0, 10);
  return date.toISOString().slice(0, 10);
}

function buildCounterClosingCashRows(handoverSheets, denominationsBySheet, manualEntries) {
  const rows = [];

  handoverSheets.forEach((sheet) => {
    const sheetRows = denominationsBySheet[Number(sheet.id)] || [];
    sheetRows.forEach((noteRow, index) => {
      const denomination = Number(noteRow.denomination_value || 0);
      const quantity = Number(noteRow.quantity || 0);
      const amount = Number(noteRow.amount || 0);
      rows.push({
        Date: index === 0 ? formatCashAccountDate(sheet.closing_date) : '',
        SortDate: formatCashAccountDate(sheet.closing_date),
        Details: index === 0 ? `COUNTER ${sheet.counter_no} SALE` : '',
        Counter: index === 0 ? `C.${sheet.counter_no}` : '',
        'Note Detail': `${denomination.toFixed(2)} x ${quantity}`,
        'DR Rs': amount,
        'CR Rs': 0,
        'dr/cr': 'Dr',
        Source: 'AUTO',
        SourceId: Number(sheet.id || 0),
        Sequence: index
      });
    });
  });

  manualEntries.forEach((entry, index) => {
    const direction = entry.direction === 'DR' ? 'DR' : 'CR';
    rows.push({
      Date: formatCashAccountDate(entry.entry_date),
      SortDate: formatCashAccountDate(entry.entry_date),
      Details: entry.details || entry.account_name || '',
      Counter: entry.counter_no ? `C.${entry.counter_no}` : '',
      'Note Detail': '',
      'DR Rs': direction === 'DR' ? Number(entry.amount || 0) : 0,
      'CR Rs': direction === 'CR' ? Number(entry.amount || 0) : 0,
      'dr/cr': direction === 'DR' ? 'Dr' : 'Cr',
      Source: 'MANUAL',
      SourceId: Number(entry.id || 0),
      Sequence: 100000 + index
    });
  });

  let balance = 0;
  return rows
    .sort((a, b) => String(a.SortDate).localeCompare(String(b.SortDate)) || a.Sequence - b.Sequence)
    .map((row) => {
      balance += Number(row['DR Rs'] || 0) - Number(row['CR Rs'] || 0);
      return {
        Date: row.Date,
        Details: row.Details,
        Counter: row.Counter,
        'Note Detail': row['Note Detail'],
        'DR Rs': row['DR Rs'] || '',
        'CR Rs': row['CR Rs'] || '',
        'Balance Rs': balance,
        'dr/cr': row['dr/cr'],
        Source: row.Source,
        SourceId: row.SourceId
      };
    });
}

function voucherTypeLabel(type) {
  if (type === 'CREDITOR_PAYMENT') return 'Creditor Payment';
  if (type === 'DEBTOR_RECEIPT') return 'Debtor Receipt';
  if (type === 'EXPENSE') return 'Expense Voucher';
  if (type === 'CUSTOMER_CREDIT') return 'Customer Credit';
  return 'Voucher';
}

function voucherDebit(row) {
  if (row.voucher_type === 'CREDITOR_PAYMENT') return Number(row.amount || 0);
  if (row.voucher_type === 'EXPENSE') return Number(row.amount || 0);
  if (row.voucher_type === 'CUSTOMER_CREDIT') return Number(row.amount || 0);
  return 0;
}

function voucherCredit(row) {
  return row.voucher_type === 'DEBTOR_RECEIPT' ? Number(row.amount || 0) : 0;
}

router.get('/summary', async (req, res) => {
  try {
    const from = normalizeDate(req.query.from || req.query.date);
    const to = normalizeDate(req.query.to || from, from);
    const inwardPaymentModeExpr = await hasColumn('inward_entries', 'payment_mode') ? 'payment_mode' : "'Credit' AS payment_mode";
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

router.get('/accounting', async (req, res) => {
  try {
    const from = normalizeDate(req.query.from || req.query.date);
    const to = normalizeDate(req.query.to || from, from);
    const inwardPaymentModeExpr = await hasColumn('inward_entries', 'payment_mode') ? 'payment_mode' : "'Credit' AS payment_mode";

    const [sales] = await db.query(
      `SELECT created_at, invoice_no, customer_name, payment_mode, sub_total, gst_total, total_cgst,
              total_sgst, total_igst, grand_total, cash_received, change_returned, billing_counter,
              transaction_type, billing_tier, tax_type
       FROM invoices
       WHERE DATE(created_at) BETWEEN ? AND ? AND invoice_status <> 'CANCELLED'
       ORDER BY created_at ASC`,
      [from, to]
    );

    const [purchases] = await db.query(
      `SELECT created_at, inward_no, supplier_name, supplier_invoice_no, supplier_invoice_date,
              item_count, total_qty, taxable_total, gst_total, total_cgst, total_sgst,
              total_igst, grand_total, tax_type, ${inwardPaymentModeExpr}
       FROM inward_entries
       WHERE DATE(created_at) BETWEEN ? AND ?
       ORDER BY created_at ASC`,
      [from, to]
    );

    const [cashLedger] = await db.query(
      `SELECT created_at, entry_date, counter_no, source_type, source_id, account_name, details,
              direction, amount, payment_mode
       FROM counter_cash_ledger_entries
       WHERE entry_date BETWEEN ? AND ?
       ORDER BY entry_date ASC, created_at ASC, id ASC`,
      [from, to]
    );

    const [cashAccountManualEntries] = await db.query(
      `SELECT id, entry_date, counter_no, details, direction, amount, created_by, created_at
       FROM counter_cash_ledger_entries
       WHERE entry_date BETWEEN ? AND ?
         AND source_type = ?
       ORDER BY entry_date ASC, created_at ASC, id ASC`,
      [from, to, CASH_ACCOUNT_MANUAL_SOURCE]
    );

    const [handoverSheets] = await db.query(
      `SELECT id, closing_date, counter_no, sheet_no, opening_cash, counter_sales, all_counter_sales,
               cash_sales, upi_sales, card_sales, dr_total, cr_total, notes_total, cash_balance,
               variance_amount, handed_over_by, taken_over_by,
               DATE_FORMAT(created_at, '%Y-%m-%d %H:%i:%s') AS created_at,
               DATE_FORMAT(updated_at, '%Y-%m-%d %H:%i:%s') AS updated_at
        FROM counter_handover_sheets
        WHERE closing_date BETWEEN ? AND ?
        ORDER BY closing_date ASC, counter_no ASC`,
      [from, to]
    );
    const handoverDenominationsBySheet = {};
    if (handoverSheets.length) {
      const [handoverDenominations] = await db.query(
        `SELECT sheet_id, denomination_label, denomination_value, quantity, amount
         FROM counter_handover_denominations
         WHERE sheet_id IN (?)
         ORDER BY denomination_value DESC`,
        [handoverSheets.map((row) => row.id)]
      );
      handoverDenominations.forEach((row) => {
        const key = Number(row.sheet_id);
        if (!handoverDenominationsBySheet[key]) handoverDenominationsBySheet[key] = [];
        handoverDenominationsBySheet[key].push(row);
      });
    }

    const [counterSalesRows] = await db.query(
      `SELECT billing_counter,
              COALESCE(SUM(CASE WHEN payment_mode = 'Cash' THEN grand_total ELSE 0 END), 0) AS cash_sales,
              COALESCE(SUM(CASE WHEN payment_mode = 'UPI' THEN grand_total ELSE 0 END), 0) AS upi_sales,
              COALESCE(SUM(CASE WHEN payment_mode = 'Card' THEN grand_total ELSE 0 END), 0) AS card_sales,
              COALESCE(SUM(grand_total), 0) AS total_sales,
              COUNT(*) AS bills
       FROM invoices
       WHERE DATE(created_at) BETWEEN ? AND ? AND invoice_status <> 'CANCELLED'
       GROUP BY billing_counter
       ORDER BY billing_counter`,
      [from, to]
    );

    const [digitalSettlementRows] = await db.query(
      `SELECT settlement_date, payment_mode, billing_counter,
              SUM(amount) AS amount,
              COUNT(DISTINCT invoice_no) AS bills
       FROM (
         SELECT DATE(i.created_at) AS settlement_date, ip.payment_mode, i.billing_counter, ip.amount, i.invoice_no
         FROM invoice_payments ip
         INNER JOIN invoices i ON i.invoice_no = ip.invoice_no
         WHERE DATE(i.created_at) BETWEEN ? AND ?
           AND i.invoice_status <> 'CANCELLED'
           AND ip.payment_mode IN ('UPI', 'Card')
         UNION ALL
         SELECT DATE(i.created_at) AS settlement_date, i.payment_mode, i.billing_counter, i.grand_total AS amount, i.invoice_no
         FROM invoices i
         LEFT JOIN invoice_payments ip ON ip.invoice_no = i.invoice_no
         WHERE DATE(i.created_at) BETWEEN ? AND ?
           AND i.invoice_status <> 'CANCELLED'
           AND ip.id IS NULL
           AND i.payment_mode IN ('UPI', 'Card')
       ) payments
       GROUP BY settlement_date, payment_mode, billing_counter
       ORDER BY settlement_date ASC, billing_counter ASC, payment_mode ASC`,
      [from, to, from, to]
    );

    const [taxSales] = await db.query(
      `SELECT ii.gst_percent,
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
       ORDER BY ii.gst_percent`,
      [from, to]
    );

    const [taxPurchases] = await db.query(
      `SELECT ii.gst_percent,
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
       ORDER BY ii.gst_percent`,
      [from, to]
    );

    const [stockRows] = await db.query(
      `SELECT COALESCE(SUM(stock_qty * purchase_price), 0) AS stock_value,
              COALESCE(SUM(stock_qty), 0) AS stock_qty,
              COUNT(*) AS product_count
       FROM products`
    );

    let vouchers = [];
    if (await hasTable('accounting_vouchers')) {
      [vouchers] = await db.query(
        `SELECT voucher_no, voucher_date, voucher_type, account_name, payment_mode, amount, reference_no, remarks, created_by, created_at
         FROM accounting_vouchers
         WHERE voucher_date BETWEEN ? AND ?
         ORDER BY voucher_date ASC, id ASC`,
        [from, to]
      );
    }

    let supplierPayments = [];
    if (await hasTable('supplier_payments')) {
      [supplierPayments] = await db.query(
        `SELECT id, inward_no, supplier_name, supplier_gstin, payment_date, amount, payment_mode, reference_no, notes, created_by, created_at
         FROM supplier_payments
         WHERE payment_date BETWEEN ? AND ?
         ORDER BY payment_date ASC, id ASC`,
        [from, to]
      );
    }

    const [openPayables] = await db.query(
      `SELECT inward_no, supplier_name, supplier_invoice_no, supplier_invoice_date, created_at,
              grand_total, paid_amount, due_amount, payment_status, due_date
       FROM inward_entries
       WHERE posting_status = 'POSTED'
         AND COALESCE(payment_mode, 'Credit') <> 'Cash'
         AND COALESCE(due_amount, 0) > 0.01
         AND DATE(created_at) <= ?
       ORDER BY COALESCE(due_date, supplier_invoice_date, DATE(created_at)) ASC, supplier_name ASC`,
      [to]
    );

    const supplierNames = Array.from(new Set(purchases.filter((row) => row.payment_mode !== 'Cash').map((row) => String(row.supplier_name || '').trim()).filter(Boolean)));
    const voucherCustomerNames = vouchers
      .filter((row) => ['CUSTOMER_CREDIT', 'DEBTOR_RECEIPT'].includes(row.voucher_type))
      .map((row) => String(row.account_name || '').trim())
      .filter(Boolean);
    const customerNames = Array.from(new Set([
      ...sales.map((row) => String(row.customer_name || 'Walk-in Customer').trim()).filter(Boolean),
      ...voucherCustomerNames
    ]));
    const sum = (rows, field) => rows.reduce((total, row) => total + Number(row[field] || 0), 0);
    const cashSales = sales.filter((row) => row.payment_mode === 'Cash');
    const upiSales = sales.filter((row) => row.payment_mode === 'UPI');
    const cardSales = sales.filter((row) => row.payment_mode === 'Card');
    const salesTotal = sum(sales, 'grand_total');
    const purchaseTotal = sum(purchases, 'grand_total');
    const salesTax = sum(sales, 'gst_total');
    const purchaseTax = sum(purchases, 'gst_total');
    const cashDr = sum(cashLedger.filter((row) => row.direction === 'DR'), 'amount');
    const cashCr = sum(cashLedger.filter((row) => row.direction === 'CR'), 'amount');
    const cashVoucherPayments = sum(vouchers.filter((row) => ['CREDITOR_PAYMENT', 'EXPENSE'].includes(row.voucher_type) && row.payment_mode === 'Cash'), 'amount');
    const cashVoucherReceipts = sum(vouchers.filter((row) => row.voucher_type === 'DEBTOR_RECEIPT' && row.payment_mode === 'Cash'), 'amount');
    const cashSupplierPayments = sum(supplierPayments.filter((row) => row.payment_mode === 'Cash'), 'amount');
    const stockValue = Number(stockRows[0]?.stock_value || 0);
    const grossProfit = salesTotal - purchaseTotal;
    const cashSalesTotal = sum(cashSales, 'grand_total');
    const upiSalesTotal = sum(upiSales, 'grand_total');
    const cardSalesTotal = sum(cardSales, 'grand_total');
    const cashPurchases = purchases.filter((row) => row.payment_mode === 'Cash');
    const declaredCounterCash = sum(handoverSheets, 'cash_balance');
    const cashPurchaseTotal = sum(cashPurchases, 'grand_total');
    const counterCashBalance = handoverSheets.length ? declaredCounterCash : cashSalesTotal + cashDr + cashVoucherReceipts - cashCr - cashPurchaseTotal - cashVoucherPayments - cashSupplierPayments;
    const counterClosingCashRows = buildCounterClosingCashRows(handoverSheets, handoverDenominationsBySheet, cashAccountManualEntries);
    const counterClosingCashDr = sum(counterClosingCashRows, 'DR Rs');
    const counterClosingCashCr = sum(counterClosingCashRows, 'CR Rs');
    const counterClosingCashBalance = counterClosingCashDr - counterClosingCashCr;

    const dayBookRows = [
      ...sales.map((row) => ({
        Date: row.created_at,
        Voucher: row.invoice_no,
        Particulars: row.customer_name || 'Walk-in Customer',
        Type: 'Sales',
        Mode: row.payment_mode,
        Debit: Number(row.grand_total || 0),
        Credit: 0,
        Amount: Number(row.grand_total || 0)
      })),
      ...purchases.map((row) => ({
        Date: row.created_at,
        Voucher: row.inward_no,
        Particulars: row.supplier_name,
        Type: row.payment_mode === 'Cash' ? 'Cash Purchase' : 'Credit Purchase',
        Mode: row.payment_mode || 'Credit',
        Debit: 0,
        Credit: Number(row.grand_total || 0),
        Amount: Number(row.grand_total || 0)
      })),
      ...cashLedger.map((row) => ({
        Date: row.created_at || row.entry_date,
        Voucher: `${row.source_type}-${row.source_id || ''}`,
        Particulars: row.account_name,
        Type: 'Counter Cash',
        Mode: row.direction,
        Debit: row.direction === 'DR' ? Number(row.amount || 0) : 0,
        Credit: row.direction === 'CR' ? Number(row.amount || 0) : 0,
        Amount: Number(row.amount || 0),
        Details: row.details
      })),
      ...vouchers.map((row) => ({
        Date: row.created_at || row.voucher_date,
        Voucher: row.voucher_no,
        Particulars: row.account_name,
        Type: voucherTypeLabel(row.voucher_type),
        Mode: row.payment_mode,
        Debit: voucherDebit(row),
        Credit: voucherCredit(row),
        Amount: Number(row.amount || 0),
        Details: row.remarks || row.reference_no || ''
      })),
      ...supplierPayments.map((row) => ({
        Date: row.created_at || row.payment_date,
        Voucher: `SP-${row.id}`,
        Particulars: row.supplier_name,
        Type: 'Supplier Payment',
        Mode: row.payment_mode,
        Debit: 0,
        Credit: Number(row.amount || 0),
        Amount: Number(row.amount || 0),
        Details: `${row.inward_no}${row.reference_no ? ` - ${row.reference_no}` : ''}${row.notes ? ` - ${row.notes}` : ''}`
      }))
    ].sort((a, b) => new Date(a.Date) - new Date(b.Date));

    const sundryCreditorRows = [
      ...purchases.filter((row) => row.payment_mode !== 'Cash').map((row) => ({
        Date: row.created_at,
        Account: row.supplier_name,
        Voucher: row.inward_no,
        Particulars: `Purchase Bill ${row.supplier_invoice_no || row.inward_no}`,
        Debit: 0,
        Credit: Number(row.grand_total || 0),
        Balance: Number(row.grand_total || 0),
        'Balance Type': 'Cr'
      })),
      ...cashLedger
        .filter((row) => supplierNames.includes(String(row.account_name || '').trim()))
        .map((row) => ({
          Date: row.created_at || row.entry_date,
          Account: row.account_name,
          Voucher: `${row.source_type}-${row.source_id || ''}`,
          Particulars: row.details,
          Debit: row.direction === 'CR' ? Number(row.amount || 0) : 0,
          Credit: row.direction === 'DR' ? Number(row.amount || 0) : 0,
          Balance: Number(row.amount || 0),
          'Balance Type': row.direction === 'CR' ? 'Dr' : 'Cr'
        })),
      ...vouchers
        .filter((row) => row.voucher_type === 'CREDITOR_PAYMENT')
        .map((row) => ({
          Date: row.created_at || row.voucher_date,
          Account: row.account_name,
          Voucher: row.voucher_no,
          Particulars: `Payment by ${row.payment_mode}${row.reference_no ? ` - ${row.reference_no}` : ''}`,
          Debit: Number(row.amount || 0),
          Credit: 0,
          Balance: Number(row.amount || 0),
          'Balance Type': 'Dr'
        })),
      ...supplierPayments
        .map((row) => ({
          Date: row.created_at || row.payment_date,
          Account: row.supplier_name,
          Voucher: `SP-${row.id}`,
          Particulars: `Payment for ${row.inward_no} by ${row.payment_mode}${row.reference_no ? ` - ${row.reference_no}` : ''}`,
          Debit: Number(row.amount || 0),
          Credit: 0,
          Balance: Number(row.amount || 0),
          'Balance Type': 'Dr'
        }))
    ].sort((a, b) => String(a.Account).localeCompare(String(b.Account)) || new Date(a.Date) - new Date(b.Date));
    const creditorBalance = sundryCreditorRows.reduce((total, row) => total + Number(row.Credit || 0) - Number(row.Debit || 0), 0);

    const sundryDebtorRows = [
      ...sales.map((row) => {
        const account = row.customer_name || 'Walk-in Customer';
        const amount = Number(row.grand_total || 0);
        return [
          {
            Date: row.created_at,
            Account: account,
            Voucher: row.invoice_no,
            Particulars: 'Sales Bill',
            Debit: amount,
            Credit: 0,
            Balance: amount,
            'Balance Type': 'Dr'
          },
          {
            Date: row.created_at,
            Account: account,
            Voucher: row.invoice_no,
            Particulars: `Payment Received - ${row.payment_mode}`,
            Debit: 0,
            Credit: amount,
            Balance: 0,
            'Balance Type': 'Settled'
          }
        ];
      }).flat(),
      ...cashLedger
        .filter((row) => customerNames.includes(String(row.account_name || '').trim()))
        .map((row) => ({
          Date: row.created_at || row.entry_date,
          Account: row.account_name,
          Voucher: `${row.source_type}-${row.source_id || ''}`,
          Particulars: row.details,
          Debit: row.direction === 'DR' ? Number(row.amount || 0) : 0,
          Credit: row.direction === 'CR' ? Number(row.amount || 0) : 0,
          Balance: Number(row.amount || 0),
          'Balance Type': row.direction === 'DR' ? 'Dr' : 'Cr'
        })),
      ...vouchers
        .filter((row) => row.voucher_type === 'DEBTOR_RECEIPT')
        .map((row) => ({
          Date: row.created_at || row.voucher_date,
          Account: row.account_name,
          Voucher: row.voucher_no,
          Particulars: `Receipt by ${row.payment_mode}${row.reference_no ? ` - ${row.reference_no}` : ''}`,
          Debit: 0,
          Credit: Number(row.amount || 0),
          Balance: Number(row.amount || 0),
          'Balance Type': 'Cr'
        })),
      ...vouchers
        .filter((row) => row.voucher_type === 'CUSTOMER_CREDIT')
        .map((row) => ({
          Date: row.created_at || row.voucher_date,
          Account: row.account_name,
          Voucher: row.voucher_no,
          Particulars: `Temporary credit${row.remarks ? ` - ${row.remarks}` : ''}`,
          Debit: Number(row.amount || 0),
          Credit: 0,
          Balance: Number(row.amount || 0),
          'Balance Type': 'Dr'
        }))
    ].sort((a, b) => String(a.Account).localeCompare(String(b.Account)) || new Date(a.Date) - new Date(b.Date));
    const debtorBalance = sundryDebtorRows.reduce((total, row) => total + Number(row.Debit || 0) - Number(row.Credit || 0), 0);

    const payableAgingRows = openPayables.map((row) => {
      const dueDate = row.due_date || row.supplier_invoice_date || row.created_at;
      const overdueDays = Math.max(daysBetween(dueDate, to), 0);
      const bucket = agingBucket(overdueDays);
      return {
        Supplier: row.supplier_name,
        'Inward No': row.inward_no,
        'Supplier Invoice': row.supplier_invoice_no || '',
        'Bill Date': row.supplier_invoice_date || row.created_at,
        'Due Date': row.due_date || '',
        'Bill Total': Number(row.grand_total || 0),
        Paid: Number(row.paid_amount || 0),
        Due: Number(row.due_amount || 0),
        'Overdue Days': overdueDays,
        Bucket: bucket,
        Status: row.payment_status || 'DUE'
      };
    });
    const payableAgingSummary = emptyAgingSummary();
    payableAgingSummary.accounts = new Set(payableAgingRows.map((row) => row.Supplier)).size;
    payableAgingSummary.bills = payableAgingRows.length;
    payableAgingRows.forEach((row) => addAgingAmount(payableAgingSummary, row.Bucket, Number(row.Due || 0)));

    const receivableBalances = sundryDebtorRows.reduce((acc, row) => {
      const account = String(row.Account || '').trim();
      if (!account || account === 'Walk-in Customer') return acc;
      acc[account] = (acc[account] || 0) + Number(row.Debit || 0) - Number(row.Credit || 0);
      return acc;
    }, {});
    const receivableAgingRows = Object.entries(receivableBalances)
      .filter(([, balance]) => balance > 0.01)
      .map(([account, balance]) => ({
        Customer: account,
        'Reference Date': to,
        'Due Date': to,
        'Bill Total': balance,
        Received: 0,
        Due: balance,
        'Overdue Days': 0,
        Bucket: 'Not Due',
        Status: 'OPEN'
      }));
    const receivableAgingSummary = emptyAgingSummary();
    receivableAgingSummary.accounts = receivableAgingRows.length;
    receivableAgingSummary.bills = receivableAgingRows.length;
    receivableAgingRows.forEach((row) => addAgingAmount(receivableAgingSummary, row.Bucket, Number(row.Due || 0)));

    const bankSettlementRows = digitalSettlementRows.map((row) => ({
      Date: row.settlement_date,
      Counter: row.billing_counter || '-',
      Mode: row.payment_mode,
      Bills: Number(row.bills || 0),
      'Expected Bank Credit': Number(row.amount || 0),
      'Matched Bank Credit': 0,
      Difference: Number(row.amount || 0),
      Status: 'To Reconcile'
    }));
    const bankSettlementSummary = {
      entries: bankSettlementRows.length,
      upi: bankSettlementRows.filter((row) => row.Mode === 'UPI').reduce((sum, row) => sum + Number(row['Expected Bank Credit'] || 0), 0),
      card: bankSettlementRows.filter((row) => row.Mode === 'Card').reduce((sum, row) => sum + Number(row['Expected Bank Credit'] || 0), 0),
      expected: bankSettlementRows.reduce((sum, row) => sum + Number(row['Expected Bank Credit'] || 0), 0),
      matched: 0,
      pending: bankSettlementRows.reduce((sum, row) => sum + Number(row.Difference || 0), 0)
    };

    res.json({
      from,
      to,
      books: {
        dayBook: {
          title: 'Day Book',
          summary: { debit: dayBookRows.reduce((t, r) => t + r.Debit, 0), credit: dayBookRows.reduce((t, r) => t + r.Credit, 0), entries: dayBookRows.length },
          columns: ['Date', 'Voucher', 'Particulars', 'Type', 'Mode', 'Debit', 'Credit', 'Amount', 'Details'],
          rows: dayBookRows
        },
        cashBook: {
          title: 'Cash Book',
          summary: { cash: cashSalesTotal, upi: upiSalesTotal, card: cardSalesTotal, cashDr: cashDr + cashVoucherReceipts, cashCr: cashCr + cashPurchaseTotal + cashVoucherPayments + cashSupplierPayments, closing: cashSalesTotal + cashDr + cashVoucherReceipts - cashCr - cashPurchaseTotal - cashVoucherPayments - cashSupplierPayments },
          columns: ['Date', 'Voucher', 'Particulars', 'Cash', 'UPI', 'Card', 'Receipts', 'Payments', 'Balance Type'],
          rows: [
            ...sales.map((row) => ({
              Date: row.created_at,
              Voucher: row.invoice_no,
              Particulars: `${row.payment_mode} Sale - ${row.customer_name || 'Walk-in Customer'}`,
              Cash: row.payment_mode === 'Cash' ? Number(row.grand_total || 0) : 0,
              UPI: row.payment_mode === 'UPI' ? Number(row.grand_total || 0) : 0,
              Card: row.payment_mode === 'Card' ? Number(row.grand_total || 0) : 0,
              Receipts: Number(row.grand_total || 0),
              Payments: 0,
              'Balance Type': row.payment_mode
            })),
            ...cashLedger.map((row) => ({ Date: row.created_at || row.entry_date, Voucher: `${row.source_type}-${row.source_id || ''}`, Particulars: row.details, Cash: row.direction === 'DR' ? Number(row.amount || 0) : 0, UPI: 0, Card: 0, Receipts: row.direction === 'DR' ? Number(row.amount || 0) : 0, Payments: row.direction === 'CR' ? Number(row.amount || 0) : 0, 'Balance Type': row.account_name }))
            ,
            ...cashPurchases.map((row) => ({ Date: row.created_at, Voucher: row.inward_no, Particulars: `Cash Purchase - ${row.supplier_name}`, Cash: 0, UPI: 0, Card: 0, Receipts: 0, Payments: Number(row.grand_total || 0), 'Balance Type': 'Cash Purchase' })),
            ...vouchers.map((row) => ({
              Date: row.created_at || row.voucher_date,
              Voucher: row.voucher_no,
              Particulars: `${voucherTypeLabel(row.voucher_type)} - ${row.account_name}`,
              Cash: row.payment_mode === 'Cash' && row.voucher_type !== 'CUSTOMER_CREDIT' ? Number(row.amount || 0) : 0,
              UPI: 0,
              Card: 0,
              Receipts: row.voucher_type === 'DEBTOR_RECEIPT' ? Number(row.amount || 0) : 0,
              Payments: ['CREDITOR_PAYMENT', 'EXPENSE'].includes(row.voucher_type) ? Number(row.amount || 0) : 0,
              'Balance Type': row.payment_mode
            })),
            ...supplierPayments.map((row) => ({
              Date: row.created_at || row.payment_date,
              Voucher: `SP-${row.id}`,
              Particulars: `Supplier Payment - ${row.supplier_name}`,
              Cash: row.payment_mode === 'Cash' ? Number(row.amount || 0) : 0,
              UPI: row.payment_mode === 'UPI' ? Number(row.amount || 0) : 0,
              Card: 0,
              Receipts: 0,
              Payments: Number(row.amount || 0),
              'Balance Type': row.payment_mode
            }))
          ].sort((a, b) => new Date(a.Date) - new Date(b.Date))
        },
        counterCashBalance: {
          title: 'Counter Cash Balance',
          summary: { sheets: handoverSheets.length, expectedCash: cashSalesTotal, notesBalance: counterCashBalance, dr: sum(handoverSheets, 'dr_total') || cashDr, cr: sum(handoverSheets, 'cr_total') || cashCr },
          columns: ['Date', 'Counter', 'Sheet No', 'Bills', 'Opening Cash', 'Cash Sales', 'UPI', 'Card', 'DR', 'CR', 'Notes Balance', 'Variance'],
          rows: (handoverSheets.length ? handoverSheets.map((row) => ({
            Date: row.closing_date,
            Counter: row.counter_no,
            'Sheet No': row.sheet_no,
            Bills: '',
            'Opening Cash': Number(row.opening_cash || 0),
            'Cash Sales': Number(row.cash_sales || 0),
            UPI: Number(row.upi_sales || 0),
            Card: Number(row.card_sales || 0),
            DR: Number(row.dr_total || 0),
            CR: Number(row.cr_total || 0),
            'Notes Balance': Number(row.cash_balance || 0),
            Variance: Number(row.variance_amount || 0)
          })) : counterSalesRows.map((row) => ({
            Date: to,
            Counter: row.billing_counter,
            'Sheet No': 'Expected',
            Bills: Number(row.bills || 0),
            'Opening Cash': 0,
            'Cash Sales': Number(row.cash_sales || 0),
            UPI: Number(row.upi_sales || 0),
            Card: Number(row.card_sales || 0),
            DR: 0,
            CR: cashPurchaseTotal,
            'Notes Balance': Number(row.cash_sales || 0) - cashPurchaseTotal,
            Variance: 0
          })))
        },
        counterClosingSheets: {
          title: 'Counter Closing Sheets',
          summary: {
            sheets: handoverSheets.length,
            counterSales: sum(handoverSheets, 'counter_sales'),
            notesBalance: sum(handoverSheets, 'cash_balance'),
            difference: sum(handoverSheets, 'variance_amount')
          },
          columns: ['Date', 'Counter', 'Sheet No', 'Counter Sale', 'All Counter Sale', 'Cash', 'UPI', 'Card', 'DR', 'CR', 'Cash Notes', 'Notes Detail', '2000 Qty', '500 Qty', '200 Qty', '100 Qty', '50 Qty', '20 Qty', '10 Qty', '5 Qty', '2 Qty', '1 Qty', 'Difference', 'Handed Over', 'Checked By', 'Added Time', 'Edited Time', 'Action'],
          rows: handoverSheets.map((row) => {
            const denominations = handoverDenominationsBySheet[Number(row.id)] || [];
            const denominationQty = denominations.reduce((acc, item) => {
              acc[Number(item.denomination_value)] = Number(item.quantity || 0);
              return acc;
            }, {});
            const notesDetail = denominations
              .map((item) => `${item.denomination_label} x ${Number(item.quantity || 0)} = ${Number(item.amount || 0).toFixed(2)}`)
              .join(', ');
            return {
              Date: row.closing_date,
              Counter: row.counter_no,
              'Sheet No': row.sheet_no,
              'Counter Sale': Number(row.counter_sales || 0),
              'All Counter Sale': Number(row.all_counter_sales || 0),
              Cash: Number(row.cash_sales || 0),
              UPI: Number(row.upi_sales || 0),
              Card: Number(row.card_sales || 0),
              DR: Number(row.dr_total || 0),
              CR: Number(row.cr_total || 0),
              'Cash Notes': Number(row.cash_balance || 0),
              'Notes Detail': notesDetail,
              '2000 Qty': denominationQty[2000] || '',
              '500 Qty': denominationQty[500] || '',
              '200 Qty': denominationQty[200] || '',
              '100 Qty': denominationQty[100] || '',
              '50 Qty': denominationQty[50] || '',
              '20 Qty': denominationQty[20] || '',
              '10 Qty': denominationQty[10] || '',
              '5 Qty': denominationQty[5] || '',
              '2 Qty': denominationQty[2] || '',
              '1 Qty': denominationQty[1] || '',
              Difference: Number(row.variance_amount || 0),
              'Handed Over': row.handed_over_by || '',
              'Checked By': row.taken_over_by || '',
              'Added Time': row.created_at || '',
              'Edited Time': row.updated_at || '',
              Action: 'View'
            };
          })
        },
        counterClosingCashAccount: {
          title: CASH_ACCOUNT_LEDGER,
          summary: {
            autoSheets: handoverSheets.length,
            manualEntries: cashAccountManualEntries.length,
            dr: counterClosingCashDr,
            cr: counterClosingCashCr,
            balance: counterClosingCashBalance
          },
          columns: ['Date', 'Details', 'Counter', 'Note Detail', 'DR Rs', 'CR Rs', 'Balance Rs', 'dr/cr'],
          rows: counterClosingCashRows
        },
        purchaseBook: {
          title: 'Purchase Book',
          summary: { purchases: purchaseTotal, entries: purchases.length, inputTax: purchaseTax },
          columns: ['Date', 'Inward No', 'Supplier', 'Supplier Invoice', 'Payment', 'Items', 'Qty', 'Taxable', 'CGST', 'SGST', 'IGST', 'Total'],
          rows: purchases.map((row) => ({
            Date: row.created_at,
            'Inward No': row.inward_no,
            Supplier: row.supplier_name,
            'Supplier Invoice': row.supplier_invoice_no || '',
            Payment: row.payment_mode || 'Credit',
            Items: row.item_count,
            Qty: Number(row.total_qty || 0),
            Taxable: Number(row.taxable_total || 0),
            CGST: Number(row.total_cgst || 0),
            SGST: Number(row.total_sgst || 0),
            IGST: Number(row.total_igst || 0),
            Total: Number(row.grand_total || 0)
          }))
        },
        sundryCreditors: {
          title: 'Sundry Creditors',
          summary: {
            accounts: new Set(sundryCreditorRows.map((row) => row.Account)).size,
            debit: sum(sundryCreditorRows, 'Debit'),
            credit: sum(sundryCreditorRows, 'Credit'),
            balance: creditorBalance
          },
          columns: ['Date', 'Account', 'Voucher', 'Particulars', 'Debit', 'Credit', 'Balance', 'Balance Type'],
          rows: sundryCreditorRows
        },
        sundryDebtors: {
          title: 'Sundry Debtors',
          summary: {
            accounts: new Set(sundryDebtorRows.map((row) => row.Account)).size,
            debit: sum(sundryDebtorRows, 'Debit'),
            credit: sum(sundryDebtorRows, 'Credit'),
            balance: debtorBalance
          },
          columns: ['Date', 'Account', 'Voucher', 'Particulars', 'Debit', 'Credit', 'Balance', 'Balance Type'],
          rows: sundryDebtorRows
        },
        accountsPayableAging: {
          title: 'Payables Aging',
          summary: payableAgingSummary,
          columns: ['Supplier', 'Inward No', 'Supplier Invoice', 'Bill Date', 'Due Date', 'Bill Total', 'Paid', 'Due', 'Overdue Days', 'Bucket', 'Status'],
          rows: payableAgingRows
        },
        accountsReceivableAging: {
          title: 'Receivables Aging',
          summary: receivableAgingSummary,
          columns: ['Customer', 'Reference Date', 'Due Date', 'Bill Total', 'Received', 'Due', 'Overdue Days', 'Bucket', 'Status'],
          rows: receivableAgingRows
        },
        bankSettlement: {
          title: 'Bank / UPI / Card Settlement',
          summary: bankSettlementSummary,
          columns: ['Date', 'Counter', 'Mode', 'Bills', 'Expected Bank Credit', 'Matched Bank Credit', 'Difference', 'Status'],
          rows: bankSettlementRows
        },
        taxBook: {
          title: 'Tax Book',
          summary: { outputTax: salesTax, inputTax: purchaseTax, payable: salesTax - purchaseTax },
          columns: ['Book', 'GST%', 'Taxable', 'CGST', 'SGST', 'IGST', 'Tax', 'Total'],
          rows: [
            ...taxSales.map((row) => ({ Book: 'Sales Output GST', 'GST%': Number(row.gst_percent || 0), Taxable: Number(row.taxable || 0), CGST: Number(row.cgst || 0), SGST: Number(row.sgst || 0), IGST: Number(row.igst || 0), Tax: Number(row.tax || 0), Total: Number(row.total || 0) })),
            ...taxPurchases.map((row) => ({ Book: 'Purchase Input GST', 'GST%': Number(row.gst_percent || 0), Taxable: Number(row.taxable || 0), CGST: Number(row.cgst || 0), SGST: Number(row.sgst || 0), IGST: Number(row.igst || 0), Tax: Number(row.tax || 0), Total: Number(row.total || 0) }))
          ]
        },
        profitLoss: {
          title: 'Profit & Loss Book',
          summary: { sales: salesTotal, purchases: purchaseTotal, grossProfit },
          columns: ['Particulars', 'Debit', 'Credit'],
          rows: [
            { Particulars: 'Purchases', Debit: purchaseTotal, Credit: 0 },
            { Particulars: 'Gross Profit c/d', Debit: grossProfit > 0 ? grossProfit : 0, Credit: 0 },
            { Particulars: 'Sales', Debit: 0, Credit: salesTotal },
            { Particulars: 'Gross Loss c/d', Debit: 0, Credit: grossProfit < 0 ? Math.abs(grossProfit) : 0 }
          ]
        },
        balanceSheet: {
          title: 'Balance Sheet',
          summary: { stockValue, cashBalance: counterCashBalance, receivables: upiSalesTotal + cardSalesTotal },
          columns: ['Particulars', 'Assets', 'Liabilities'],
          rows: [
            { Particulars: 'Closing Stock at Purchase Value', Assets: stockValue, Liabilities: 0 },
            { Particulars: handoverSheets.length ? 'Counter Cash Balance (Declared)' : 'Counter Cash Balance (Expected Cash)', Assets: counterCashBalance, Liabilities: 0 },
            { Particulars: 'UPI Receivables', Assets: upiSalesTotal, Liabilities: 0 },
            { Particulars: 'Card Receivables', Assets: cardSalesTotal, Liabilities: 0 },
            { Particulars: 'Sundry Debtors', Assets: debtorBalance > 0 ? debtorBalance : 0, Liabilities: debtorBalance < 0 ? Math.abs(debtorBalance) : 0 },
            { Particulars: 'Sundry Creditors', Assets: creditorBalance < 0 ? Math.abs(creditorBalance) : 0, Liabilities: creditorBalance > 0 ? creditorBalance : 0 },
            { Particulars: 'GST Payable (+) / Credit (-)', Assets: salesTax - purchaseTax < 0 ? Math.abs(salesTax - purchaseTax) : 0, Liabilities: salesTax - purchaseTax > 0 ? salesTax - purchaseTax : 0 }
          ]
        }
      }
    });
  } catch (err) {
    console.error('Accounting books failed:', err.message);
    res.status(500).json({ error: 'Unable to load accounting books.' });
  }
});

router.post('/counter-closing-cash-account/manual', async (req, res) => {
  try {
    const entryDate = normalizeDate(req.body?.entry_date || req.body?.date);
    const details = String(req.body?.details || '').trim().slice(0, 255);
    const direction = req.body?.direction === 'DR' ? 'DR' : 'CR';
    const amount = parseMoney(req.body?.amount);
    const counterNo = Math.max(Number.parseInt(req.body?.counter_no, 10) || 0, 0) || null;

    if (!details) return res.status(400).json({ error: 'Details are required.' });
    if (amount <= 0) return res.status(400).json({ error: 'Amount must be greater than zero.' });

    const [result] = await db.query(
      `INSERT INTO counter_cash_ledger_entries
       (entry_date, counter_no, source_type, source_id, account_name, details, direction, amount, payment_mode, created_by)
       VALUES (?, ?, ?, NULL, ?, ?, ?, ?, 'MANUAL', ?)`,
      [entryDate, counterNo, CASH_ACCOUNT_MANUAL_SOURCE, CASH_ACCOUNT_LEDGER, details, direction, amount, req.user.username]
    );

    res.json({
      success: true,
      id: result.insertId,
      entry_date: entryDate,
      counter_no: counterNo,
      details,
      direction,
      amount
    });
  } catch (err) {
    console.error('Counter closing cash account manual entry failed:', err.message);
    res.status(500).json({ error: 'Unable to save counter closing cash account entry.' });
  }
});

module.exports = router;
