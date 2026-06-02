const express = require('express');
const router = express.Router();
const db = require('../config/db');
const { authenticate, authorize } = require('../middleware/auth');
const { normalizeDate } = require('../utils/formatters');

router.use(authenticate, authorize('SERVER', 'ADMIN'));

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

    const [handoverSheets] = await db.query(
      `SELECT closing_date, counter_no, sheet_no, opening_cash, counter_sales, all_counter_sales,
              cash_sales, upi_sales, card_sales, dr_total, cr_total, notes_total, cash_balance,
              variance_amount, handed_over_by, taken_over_by, created_at
       FROM counter_handover_sheets
       WHERE closing_date BETWEEN ? AND ?
       ORDER BY closing_date ASC, counter_no ASC`,
      [from, to]
    );

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

    const supplierNames = Array.from(new Set(purchases.filter((row) => row.payment_mode !== 'Cash').map((row) => String(row.supplier_name || '').trim()).filter(Boolean)));
    const customerNames = Array.from(new Set(sales.map((row) => String(row.customer_name || 'Walk-in Customer').trim()).filter(Boolean)));
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
    const cashVoucherPayments = sum(vouchers.filter((row) => row.voucher_type === 'CREDITOR_PAYMENT' && row.payment_mode === 'Cash'), 'amount');
    const cashVoucherReceipts = sum(vouchers.filter((row) => row.voucher_type === 'DEBTOR_RECEIPT' && row.payment_mode === 'Cash'), 'amount');
    const stockValue = Number(stockRows[0]?.stock_value || 0);
    const grossProfit = salesTotal - purchaseTotal;
    const cashSalesTotal = sum(cashSales, 'grand_total');
    const upiSalesTotal = sum(upiSales, 'grand_total');
    const cardSalesTotal = sum(cardSales, 'grand_total');
    const cashPurchases = purchases.filter((row) => row.payment_mode === 'Cash');
    const declaredCounterCash = sum(handoverSheets, 'cash_balance');
    const cashPurchaseTotal = sum(cashPurchases, 'grand_total');
    const counterCashBalance = handoverSheets.length ? declaredCounterCash : cashSalesTotal + cashDr + cashVoucherReceipts - cashCr - cashPurchaseTotal - cashVoucherPayments;

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
        Type: row.voucher_type === 'CREDITOR_PAYMENT' ? 'Creditor Payment' : 'Debtor Receipt',
        Mode: row.payment_mode,
        Debit: row.voucher_type === 'DEBTOR_RECEIPT' ? Number(row.amount || 0) : 0,
        Credit: row.voucher_type === 'CREDITOR_PAYMENT' ? Number(row.amount || 0) : 0,
        Amount: Number(row.amount || 0),
        Details: row.remarks || row.reference_no || ''
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
        }))
    ].sort((a, b) => String(a.Account).localeCompare(String(b.Account)) || new Date(a.Date) - new Date(b.Date));
    const debtorBalance = sundryDebtorRows.reduce((total, row) => total + Number(row.Debit || 0) - Number(row.Credit || 0), 0);

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
          summary: { cash: cashSalesTotal, upi: upiSalesTotal, card: cardSalesTotal, cashDr: cashDr + cashVoucherReceipts, cashCr: cashCr + cashPurchaseTotal + cashVoucherPayments, closing: cashSalesTotal + cashDr + cashVoucherReceipts - cashCr - cashPurchaseTotal - cashVoucherPayments },
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
              Particulars: `${row.voucher_type === 'CREDITOR_PAYMENT' ? 'Creditor Payment' : 'Debtor Receipt'} - ${row.account_name}`,
              Cash: row.payment_mode === 'Cash' ? Number(row.amount || 0) : 0,
              UPI: 0,
              Card: 0,
              Receipts: row.voucher_type === 'DEBTOR_RECEIPT' ? Number(row.amount || 0) : 0,
              Payments: row.voucher_type === 'CREDITOR_PAYMENT' ? Number(row.amount || 0) : 0,
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

module.exports = router;
