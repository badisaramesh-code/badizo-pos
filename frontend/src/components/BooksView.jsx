import React, { useEffect, useMemo, useState } from 'react';
import * as XLSX from 'xlsx';
import { fetchAccountingBooks, saveAccountingVoucher, saveCounterClosingCashAccountEntry, searchInwardSuppliers } from '../api/client';
import { todayIso } from '../utils/date';
import { formatMoney } from '../utils/money';

const COUNTER_CLOSING_VIEW_REQUEST_KEY = 'badizo_counter_closing_view_request';

const BOOK_ORDER = [
  ['dayBook', 'Day Book'],
  ['cashBook', 'Cash Book'],
  ['counterCashBalance', 'Counter Cash Balance'],
  ['counterClosingSheets', 'Counter Closing Sheets'],
  ['counterClosingCashAccount', 'Counter Closing Cash Account'],
  ['purchaseBook', 'Purchase Book'],
  ['sundryCreditors', 'Sundry Creditors'],
  ['sundryDebtors', 'Sundry Debtors'],
  ['accountsPayableAging', 'Payables Aging'],
  ['accountsReceivableAging', 'Receivables Aging'],
  ['bankSettlement', 'Bank Settlement'],
  ['taxBook', 'Tax Book'],
  ['profitLoss', 'Profit & Loss Book'],
  ['balanceSheet', 'Balance Sheet']
];

const DEFAULT_BOOKS = {
  dayBook: {
    title: 'Day Book',
    summary: { entries: 0 },
    columns: ['Date', 'Voucher', 'Particulars', 'Type', 'Mode', 'Debit', 'Credit', 'Amount', 'Details'],
    rows: []
  },
  cashBook: {
    title: 'Cash Book',
    summary: { cash: 0, upi: 0, card: 0, cashDr: 0, cashCr: 0, closing: 0 },
    columns: ['Date', 'Voucher', 'Particulars', 'Cash', 'UPI', 'Card', 'Receipts', 'Payments', 'Balance Type'],
    rows: []
  },
  counterCashBalance: {
    title: 'Counter Cash Balance',
    summary: { sheets: 0, expectedCash: 0, notesBalance: 0, dr: 0, cr: 0 },
    columns: ['Date', 'Counter', 'Sheet No', 'Bills', 'Opening Cash', 'Cash Sales', 'UPI', 'Card', 'DR', 'CR', 'Notes Balance', 'Variance'],
    rows: []
  },
  counterClosingSheets: {
    title: 'Counter Closing Sheets',
    summary: { sheets: 0, counterSales: 0, notesBalance: 0, difference: 0 },
    columns: ['Date', 'Counter', 'Sheet No', 'Counter Sale', 'All Counter Sale', 'Cash', 'UPI', 'Card', 'DR', 'CR', 'Cash Notes', 'Notes Detail', '2000 Qty', '500 Qty', '200 Qty', '100 Qty', '50 Qty', '20 Qty', '10 Qty', '5 Qty', '2 Qty', '1 Qty', 'Difference', 'Handed Over', 'Checked By', 'Added Time', 'Edited Time', 'Action'],
    rows: []
  },
  counterClosingCashAccount: {
    title: 'Counter Closing Cash Account',
    summary: { autoSheets: 0, manualEntries: 0, dr: 0, cr: 0, balance: 0 },
    columns: ['Date', 'Details', 'Counter', 'Note Detail', 'DR Rs', 'CR Rs', 'Balance Rs', 'dr/cr'],
    rows: []
  },
  purchaseBook: {
    title: 'Purchase Book',
    summary: { purchases: 0, entries: 0, inputTax: 0 },
    columns: ['Date', 'Inward No', 'Supplier', 'Supplier Invoice', 'Payment', 'Items', 'Qty', 'Taxable', 'CGST', 'SGST', 'IGST', 'Total'],
    rows: []
  },
  sundryCreditors: {
    title: 'Sundry Creditors',
    summary: { accounts: 0, debit: 0, credit: 0, balance: 0 },
    columns: ['Date', 'Account', 'Voucher', 'Particulars', 'Debit', 'Credit', 'Balance', 'Balance Type'],
    rows: []
  },
  sundryDebtors: {
    title: 'Sundry Debtors',
    summary: { accounts: 0, debit: 0, credit: 0, balance: 0 },
    columns: ['Date', 'Account', 'Voucher', 'Particulars', 'Debit', 'Credit', 'Balance', 'Balance Type'],
    rows: []
  },
  accountsPayableAging: {
    title: 'Payables Aging',
    summary: { accounts: 0, bills: 0, notDue: 0, days1To30: 0, days31To60: 0, days61To90: 0, days90Plus: 0, overdue: 0, total: 0 },
    columns: ['Supplier', 'Inward No', 'Supplier Invoice', 'Bill Date', 'Due Date', 'Bill Total', 'Paid', 'Due', 'Overdue Days', 'Bucket', 'Status'],
    rows: []
  },
  accountsReceivableAging: {
    title: 'Receivables Aging',
    summary: { accounts: 0, bills: 0, notDue: 0, days1To30: 0, days31To60: 0, days61To90: 0, days90Plus: 0, overdue: 0, total: 0 },
    columns: ['Customer', 'Reference Date', 'Due Date', 'Bill Total', 'Received', 'Due', 'Overdue Days', 'Bucket', 'Status'],
    rows: []
  },
  bankSettlement: {
    title: 'Bank / UPI / Card Settlement',
    summary: { entries: 0, upi: 0, card: 0, expected: 0, matched: 0, pending: 0 },
    columns: ['Date', 'Counter', 'Mode', 'Bills', 'Expected Bank Credit', 'Matched Bank Credit', 'Difference', 'Status'],
    rows: []
  },
  taxBook: {
    title: 'Tax Book',
    summary: { outputTax: 0, inputTax: 0, payable: 0 },
    columns: ['Book', 'GST%', 'Taxable', 'CGST', 'SGST', 'IGST', 'Tax', 'Total'],
    rows: []
  },
  profitLoss: {
    title: 'Profit & Loss Book',
    summary: { sales: 0, purchases: 0, grossProfit: 0 },
    columns: ['Particulars', 'Debit', 'Credit'],
    rows: []
  },
  balanceSheet: {
    title: 'Balance Sheet',
    summary: { stockValue: 0, cashBalance: 0, receivables: 0 },
    columns: ['Particulars', 'Assets', 'Liabilities'],
    rows: []
  }
};

function getOrderedRange(fromDate, toDate) {
  return fromDate <= toDate ? { from: fromDate, to: toDate } : { from: toDate, to: fromDate };
}

function financialYearStartIso() {
  const today = new Date();
  const year = today.getMonth() >= 3 ? today.getFullYear() : today.getFullYear() - 1;
  return `${year}-04-01`;
}

function formatCell(value, column = '') {
  if (value === null || value === undefined || value === '') return '-';
  if (column.toLowerCase().includes('date') || column === 'Time') {
    const date = new Date(value);
    if (!Number.isNaN(date.getTime())) {
      return column === 'Time' ? date.toLocaleTimeString() : date.toLocaleDateString();
    }
  }
  if (['DR Rs', 'CR Rs', 'Balance Rs'].includes(column)) {
    const amount = Number(value || 0);
    return Number.isFinite(amount) ? amount.toFixed(2) : String(value);
  }
  if (typeof value === 'number') return formatMoney(value);
  return String(value);
}

function normalizeExportRow(row, columns) {
  return columns.reduce((acc, column) => {
    acc[column] = row[column] ?? '';
    return acc;
  }, {});
}

function exportWorkbook(filename, sheets) {
  const workbook = XLSX.utils.book_new();
  sheets.forEach(({ name, columns, rows }) => {
    const exportRows = rows.length
      ? rows.map((row) => normalizeExportRow(row, columns))
      : [{ Message: 'No data available' }];
    const worksheet = XLSX.utils.json_to_sheet(exportRows);
    XLSX.utils.book_append_sheet(workbook, worksheet, name.slice(0, 31));
  });
  XLSX.writeFile(workbook, filename);
}

function isCountSummaryKey(key) {
  return ['accounts', 'entries', 'bills', 'sheets', 'itemCount', 'purchaseEntries', 'productCount'].includes(key);
}

function summaryChips(book) {
  if (!book?.summary) return [];
  return Object.entries(book.summary).map(([key, value]) => [
    key.replace(/([A-Z])/g, ' $1').replace(/^./, (char) => char.toUpperCase()),
    typeof value === 'number' ? (isCountSummaryKey(key) ? String(value) : formatMoney(value)) : value
  ]);
}

function getBookCardValue(key, book) {
  if (!book?.summary) return `${book?.rows?.length || 0} entries`;
  if (['sundryCreditors', 'sundryDebtors'].includes(key)) {
    return formatMoney(book.summary.balance || 0);
  }
  if (['accountsPayableAging', 'accountsReceivableAging'].includes(key)) return formatMoney(book.summary.total || 0);
  if (key === 'bankSettlement') return formatMoney(book.summary.pending || 0);
  if (key === 'purchaseBook') return formatMoney(book.summary.purchases || 0);
  if (key === 'cashBook') return formatMoney(book.summary.closing || 0);
  if (key === 'counterCashBalance') return formatMoney(book.summary.notesBalance || 0);
  if (key === 'counterClosingSheets') return `${book.summary.sheets || book?.rows?.length || 0} sheets`;
  if (key === 'counterClosingCashAccount') return formatMoney(book.summary.balance || 0);
  if (key === 'taxBook') return formatMoney(book.summary.payable || 0);
  if (key === 'profitLoss') return formatMoney(book.summary.grossProfit || 0);
  if (key === 'balanceSheet') return formatMoney(book.summary.stockValue || 0);
  return `${book?.rows?.length || 0} entries`;
}

function blankVoucherForm() {
  return {
    voucher_date: todayIso(),
    voucher_type: 'EXPENSE',
    account_name: '',
    payment_mode: 'Cash',
    amount: '',
    dr_amount: '',
    cr_amount: '',
    account_holder_name: '',
    bank_name: '',
    bank_account_no: '',
    bank_ifsc: '',
    upi_id: '',
    reference_no: '',
    remarks: ''
  };
}

function blankCashAccountEntryForm() {
  return {
    entry_date: todayIso(),
    details: '',
    counter_no: '',
    dr_amount: '',
    cr_amount: ''
  };
}

export default function BooksView({ setActiveWorkspace }) {
  const [fromDate, setFromDate] = useState(financialYearStartIso());
  const [toDate, setToDate] = useState(todayIso());
  const [booksData, setBooksData] = useState(null);
  const [activeBook, setActiveBook] = useState('dayBook');
  const [accountSearch, setAccountSearch] = useState('');
  const [accountSuggestions, setAccountSuggestions] = useState([]);
  const [isAccountSuggestionOpen, setIsAccountSuggestionOpen] = useState(false);
  const [voucherForm, setVoucherForm] = useState(blankVoucherForm());
  const [cashAccountEntryForm, setCashAccountEntryForm] = useState(blankCashAccountEntryForm());
  const [errorMessage, setErrorMessage] = useState('');
  const [statusMessage, setStatusMessage] = useState('');
  const [isReportOpen, setIsReportOpen] = useState(false);

  useEffect(() => {
    loadBooks();
  }, []);

  useEffect(() => {
    if (activeBook !== 'sundryCreditors') {
      setAccountSuggestions([]);
      setIsAccountSuggestionOpen(false);
      return undefined;
    }

    const query = accountSearch.trim();
    if (query.length < 3) {
      setAccountSuggestions([]);
      setIsAccountSuggestionOpen(false);
      return undefined;
    }

    let cancelled = false;
    const timer = window.setTimeout(async () => {
      try {
        const rows = await searchInwardSuppliers(query);
        if (!cancelled) {
          setAccountSuggestions(rows.slice(0, 8));
          setIsAccountSuggestionOpen(rows.length > 0);
        }
      } catch (err) {
        if (!cancelled) {
          setAccountSuggestions([]);
          setIsAccountSuggestionOpen(false);
        }
      }
    }, 250);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [accountSearch, activeBook]);

  const activeReport = booksData?.books?.[activeBook] || DEFAULT_BOOKS[activeBook];
  const isAccountSearchBook = ['sundryCreditors', 'sundryDebtors'].includes(activeBook);
  const isManualVoucherBook = activeBook === 'dayBook';
  const isCounterClosingSheetBook = activeBook === 'counterClosingSheets';
  const isCounterClosingCashAccountBook = activeBook === 'counterClosingCashAccount';
  const visibleRows = useMemo(() => {
    const rows = activeReport?.rows || [];
    const query = accountSearch.trim().toLowerCase();
    if (!query) return rows;
    if (isAccountSearchBook) return rows.filter((row) => String(row.Account || '').toLowerCase().includes(query));
    if (isCounterClosingSheetBook) {
      return rows.filter((row) => ['Date', 'Counter', 'Sheet No', 'Cash Notes', 'Notes Detail', 'Handed Over', 'Checked By', 'Added Time', 'Edited Time']
        .some((column) => String(row[column] || '').toLowerCase().includes(query)));
    }
    if (isCounterClosingCashAccountBook) {
      return rows.filter((row) => ['Date', 'Details', 'Counter', 'Note Detail', 'DR Rs', 'CR Rs', 'Balance Rs', 'dr/cr']
        .some((column) => String(row[column] || '').toLowerCase().includes(query)));
    }
    return rows;
  }, [accountSearch, activeReport, isAccountSearchBook, isCounterClosingSheetBook, isCounterClosingCashAccountBook]);

  const bookCards = useMemo(() => BOOK_ORDER.map(([key, fallbackTitle]) => {
    const book = booksData?.books?.[key] || DEFAULT_BOOKS[key];
    return {
      key,
      title: book?.title || fallbackTitle,
      value: getBookCardValue(key, book),
      entries: book?.rows?.length || 0
    };
  }), [booksData]);

  const ownerFocusCards = useMemo(() => {
    const books = booksData?.books || DEFAULT_BOOKS;
    return [
      {
        key: 'payables',
        title: 'Pay suppliers',
        value: formatMoney(books.accountsPayableAging?.summary?.total || 0),
        note: `${books.accountsPayableAging?.summary?.bills || 0} open bills`,
        actionBook: 'accountsPayableAging'
      },
      {
        key: 'receivables',
        title: 'Collect money',
        value: formatMoney(books.accountsReceivableAging?.summary?.total || 0),
        note: `${books.accountsReceivableAging?.summary?.accounts || 0} customers`,
        actionBook: 'accountsReceivableAging'
      },
      {
        key: 'settlement',
        title: 'Check bank credit',
        value: formatMoney(books.bankSettlement?.summary?.pending || 0),
        note: 'UPI/Card to reconcile',
        actionBook: 'bankSettlement'
      },
      {
        key: 'gst',
        title: 'GST payable',
        value: formatMoney(books.taxBook?.summary?.payable || 0),
        note: 'Output minus input tax',
        actionBook: 'taxBook'
      },
      {
        key: 'stock',
        title: 'Stock value',
        value: formatMoney(books.balanceSheet?.summary?.stockValue || 0),
        note: 'As per product master',
        actionBook: 'balanceSheet'
      }
    ];
  }, [booksData]);

  async function loadBooks() {
    setErrorMessage('');
    setStatusMessage('');
    const range = getOrderedRange(fromDate, toDate);
    let result = { from: range.from, to: range.to, books: DEFAULT_BOOKS };

    try {
      result = await fetchAccountingBooks(range);
    } catch (err) {
      setErrorMessage(err.response?.data?.error || 'Unable to load full accounting books. Showing available book formats.');
    }

    setBooksData({
      ...result,
      books: {
        ...DEFAULT_BOOKS,
        ...(result.books || {})
      }
    });
  }

  function updateVoucher(field, value) {
    setVoucherForm((current) => ({ ...current, [field]: value }));
  }

  function updateCashAccountEntry(field, value) {
    setCashAccountEntryForm((current) => ({ ...current, [field]: value }));
  }

  function selectCreditorAccount(match) {
    const accountName = match.name || '';
    setAccountSearch(accountName);
    setVoucherForm((current) => ({
      ...current,
      account_name: accountName,
      account_holder_name: match.account_holder_name || current.account_holder_name || accountName,
      bank_name: match.bank_name || current.bank_name || '',
      bank_account_no: match.bank_account_no || current.bank_account_no || '',
      bank_ifsc: String(match.bank_ifsc || current.bank_ifsc || '').toUpperCase(),
      upi_id: match.upi_id || current.upi_id || ''
    }));
    setAccountSuggestions([]);
    setIsAccountSuggestionOpen(false);
  }

  async function submitVoucher(event) {
    event.preventDefault();
    setErrorMessage('');
    setStatusMessage('');
    const voucherType = isManualVoucherBook
      ? voucherForm.voucher_type
      : activeBook === 'sundryDebtors'
        ? 'DEBTOR_RECEIPT'
        : 'CREDITOR_PAYMENT';
    const voucherDrAmount = Number(voucherForm.dr_amount || 0);
    const voucherCrAmount = Number(voucherForm.cr_amount || 0);
    const voucherAmount = isManualVoucherBook
      ? voucherDrAmount > 0 ? voucherDrAmount : voucherCrAmount
      : Number(voucherForm.amount || 0);
    const debitVoucherTypes = new Set(['EXPENSE', 'CUSTOMER_CREDIT', 'CREDITOR_PAYMENT']);

    if (isManualVoucherBook) {
      if (voucherDrAmount > 0 && voucherCrAmount > 0) {
        setErrorMessage('Enter amount in either DR Rs or CR Rs, not both.');
        return;
      }
      if (voucherDrAmount <= 0 && voucherCrAmount <= 0) {
        setErrorMessage('Enter amount in DR Rs or CR Rs.');
        return;
      }
      if (voucherDrAmount > 0 && !debitVoucherTypes.has(voucherType)) {
        setErrorMessage('Customer Receipt should be entered in CR Rs.');
        return;
      }
      if (voucherCrAmount > 0 && voucherType !== 'DEBTOR_RECEIPT') {
        setErrorMessage('Expense, Customer Credit, and Supplier Payment should be entered in DR Rs.');
        return;
      }
    }

    try {
      const result = await saveAccountingVoucher({
        ...voucherForm,
        voucher_date: voucherForm.voucher_date || toDate,
        voucher_type: voucherType,
        amount: voucherAmount
      });
      setStatusMessage(`${result.voucher_no} saved for ${result.account_name}.`);
      setVoucherForm(blankVoucherForm());
      await loadBooks();
    } catch (err) {
      setErrorMessage(err.response?.data?.error || 'Unable to save voucher.');
    }
  }

  async function submitCashAccountEntry(event) {
    event.preventDefault();
    setErrorMessage('');
    setStatusMessage('');
    const drAmount = Number(cashAccountEntryForm.dr_amount || 0);
    const crAmount = Number(cashAccountEntryForm.cr_amount || 0);
    if (drAmount > 0 && crAmount > 0) {
      setErrorMessage('Enter amount in either DR Rs or CR Rs, not both.');
      return;
    }
    if (drAmount <= 0 && crAmount <= 0) {
      setErrorMessage('Enter amount in DR Rs or CR Rs.');
      return;
    }
    try {
      const result = await saveCounterClosingCashAccountEntry({
        entry_date: cashAccountEntryForm.entry_date,
        details: cashAccountEntryForm.details,
        counter_no: cashAccountEntryForm.counter_no,
        direction: drAmount > 0 ? 'DR' : 'CR',
        amount: drAmount > 0 ? drAmount : crAmount
      });
      setStatusMessage(`Counter closing cash entry saved: ${result.details}.`);
      setCashAccountEntryForm(blankCashAccountEntryForm());
      await loadBooks();
    } catch (err) {
      setErrorMessage(err.response?.data?.error || 'Unable to save counter closing cash account entry.');
    }
  }

  function handleBooksSubmit(event) {
    event.preventDefault();
    loadBooks();
  }

  function exportSelectedExcel() {
    if (!activeReport) return;
    const { from, to } = getOrderedRange(fromDate, toDate);
    exportWorkbook(`badizo_${activeReport.title.replace(/\s+/g, '_').toLowerCase()}_${from}_to_${to}.xlsx`, [
      { name: activeReport.title, columns: activeReport.columns, rows: visibleRows }
    ]);
  }

  function exportAllExcel() {
    if (!booksData?.books) return;
    const { from, to } = getOrderedRange(fromDate, toDate);
    exportWorkbook(`badizo_accounting_books_${from}_to_${to}.xlsx`, BOOK_ORDER.map(([key, fallbackTitle]) => {
      const book = booksData.books[key] || { title: fallbackTitle, columns: [], rows: [] };
      return { name: book.title || fallbackTitle, columns: book.columns || [], rows: book.rows || [] };
    }));
  }

  function printSelectedBook() {
    setIsReportOpen(true);
    window.setTimeout(() => {
      document.body.classList.add('printing-books');
      window.print();
      setTimeout(() => document.body.classList.remove('printing-books'), 300);
    }, 50);
  }

  function viewCounterClosingSheet(row) {
    const date = row?.Date;
    const counterNo = Number(row?.Counter || 1);
    if (!date) return;
    window.sessionStorage.setItem(COUNTER_CLOSING_VIEW_REQUEST_KEY, JSON.stringify({ date, counterNo }));
    setStatusMessage(`Opening ${row['Sheet No'] || 'counter closing sheet'} in Counter Closing.`);
    setActiveWorkspace?.('closing');
  }

  return (
    <div className="form-stack books-view">
      {errorMessage && <div className="alert-box">{errorMessage}</div>}
      {statusMessage && <div className="change-box">{statusMessage}</div>}
      <section className="panel">
        <div className="panel-header green">
          <h2 className="panel-title">Ledger Books</h2>
        </div>
        <div className="panel-body form-stack">
          <form className="books-control-row" onSubmit={handleBooksSubmit}>
            <label className="date-range-field">
              <span className="field-label">From Date</span>
              <input className="field report-date-input" type="date" value={fromDate} onChange={(event) => setFromDate(event.target.value)} />
            </label>
            <label className="date-range-field">
              <span className="field-label">To Date</span>
              <input className="field report-date-input" type="date" value={toDate} onChange={(event) => setToDate(event.target.value)} />
            </label>
            <button className="secondary-button" type="submit">Load</button>
            <button className="secondary-button" type="button" onClick={() => { setFromDate(financialYearStartIso()); setToDate(todayIso()); }}>Financial Year</button>
            <button className="secondary-button" type="button" onClick={exportAllExcel}>Export All Excel</button>
            <button className="secondary-button" type="button" onClick={printSelectedBook}>Print / PDF</button>
          </form>
          <div className="books-owner-focus">
            {ownerFocusCards.map((card) => (
              <button
                key={card.key}
                type="button"
                className="books-focus-card"
                onClick={() => {
                  setActiveBook(card.actionBook);
                  setAccountSearch('');
                  setIsReportOpen(true);
                }}
              >
                <span>{card.title}</span>
                <strong>{card.value}</strong>
                <small>{card.note}</small>
              </button>
            ))}
          </div>
          <div className="books-grid">
            {bookCards.map((book) => (
              <button
                key={book.key}
                type="button"
                className={`module-card book-select-card ${activeBook === book.key ? 'active' : ''}`}
                onClick={() => { setActiveBook(book.key); setAccountSearch(''); setIsReportOpen(true); }}
              >
                <strong>{book.title}</strong>
                <span className="muted">{book.entries} entries</span>
                <span className="status-chip">{book.value}</span>
              </button>
            ))}
          </div>
        </div>
      </section>

      <section className="panel books-report-panel">
        <div className="panel-header green">
          <div>
            <h2 className="panel-title">{activeReport?.title || 'Accounting Book'}</h2>
            <span className="muted">Date: {getOrderedRange(fromDate, toDate).from} to {getOrderedRange(fromDate, toDate).to}</span>
          </div>
          <div className="report-header-actions">
            {isReportOpen && <button className="header-print-button" type="button" onClick={exportSelectedExcel}>Export Excel</button>}
            {isReportOpen && <button className="header-print-button" type="button" onClick={printSelectedBook}>Print / PDF</button>}
            <button
              className={isReportOpen ? 'close-action-button' : 'secondary-button'}
              type="button"
              onClick={() => setIsReportOpen((current) => !current)}
            >
              {isReportOpen ? 'Close' : 'View'}
            </button>
          </div>
        </div>
        {isReportOpen && <div className="panel-body books-print-area">
          {activeReport && (
            <>
              <div className="books-print-heading">
                <h1>{activeReport.title}</h1>
                <span>{getOrderedRange(fromDate, toDate).from} to {getOrderedRange(fromDate, toDate).to}</span>
              </div>
              <div className="report-summary-strip books-summary-strip">
                {summaryChips(activeReport).map(([label, value]) => (
                  <span key={label}>{label}: <strong>{value}</strong></span>
                ))}
              </div>
              {isCounterClosingSheetBook && (
                <div className="books-account-tools">
                  <label className="supplier-lookup-field">
                    <span className="field-label">Search Sheet</span>
                    <input
                      className="field"
                      value={accountSearch}
                      onChange={(event) => setAccountSearch(event.target.value)}
                      placeholder="Search date, counter, sheet no, person, added/edited time"
                    />
                  </label>
                </div>
              )}
              {isCounterClosingCashAccountBook && (
                <div className="books-account-tools">
                  <label className="supplier-lookup-field">
                    <span className="field-label">Search Cash Account</span>
                    <input
                      className="field"
                      value={accountSearch}
                      onChange={(event) => setAccountSearch(event.target.value)}
                      placeholder="Search date, note denomination, expense, bank deposit"
                    />
                  </label>
                </div>
              )}
              {isManualVoucherBook && (
                <div className="books-account-tools">
                  <form className="voucher-entry-row" onSubmit={submitVoucher}>
                    <label>
                      <span className="field-label">Date</span>
                      <input className="field" type="date" value={voucherForm.voucher_date} onChange={(event) => updateVoucher('voucher_date', event.target.value)} required />
                    </label>
                    <label>
                      <span className="field-label">Voucher</span>
                      <select className="select" value={voucherForm.voucher_type} onChange={(event) => updateVoucher('voucher_type', event.target.value)}>
                        <option value="EXPENSE">Expense Voucher</option>
                        <option value="CUSTOMER_CREDIT">Customer Credit</option>
                        <option value="DEBTOR_RECEIPT">Customer Receipt</option>
                        <option value="CREDITOR_PAYMENT">Supplier Payment</option>
                      </select>
                    </label>
                    <label className="supplier-lookup-field">
                      <span className="field-label">Account / Details</span>
                      <input
                        className="field"
                        value={voucherForm.account_name}
                        onChange={(event) => updateVoucher('account_name', event.target.value)}
                        placeholder="Expense name / customer / supplier"
                        required
                      />
                    </label>
                    <label>
                      <span className="field-label">Mode</span>
                      <select className="select" value={voucherForm.payment_mode} onChange={(event) => updateVoucher('payment_mode', event.target.value)}>
                        <option value="Cash">Cash</option>
                        <option value="Bank">Bank</option>
                      </select>
                    </label>
                    <label>
                      <span className="field-label">DR Rs</span>
                      <input className="field" type="number" min="0" step="0.01" value={voucherForm.dr_amount} onChange={(event) => updateVoucher('dr_amount', event.target.value)} placeholder="Debit amount" />
                    </label>
                    <label>
                      <span className="field-label">CR Rs</span>
                      <input className="field" type="number" min="0" step="0.01" value={voucherForm.cr_amount} onChange={(event) => updateVoucher('cr_amount', event.target.value)} placeholder="Credit amount" />
                    </label>
                    <label>
                      <span className="field-label">Ref No</span>
                      <input className="field" value={voucherForm.reference_no} onChange={(event) => updateVoucher('reference_no', event.target.value)} />
                    </label>
                    <label>
                      <span className="field-label">Remarks</span>
                      <input className="field" value={voucherForm.remarks} onChange={(event) => updateVoucher('remarks', event.target.value)} />
                    </label>
                    <button className="primary-button compact-primary" type="submit">Save Voucher</button>
                  </form>
                </div>
              )}
              {isAccountSearchBook && (
                <div className="books-account-tools">
                  <label className="supplier-lookup-field">
                    <span className="field-label">{activeBook === 'sundryCreditors' ? 'Creditor Search' : 'Debtor Search'}</span>
                    <input
                      className="field"
                      value={accountSearch}
                      onChange={(event) => {
                        setAccountSearch(event.target.value);
                        if (activeBook === 'sundryCreditors') setIsAccountSuggestionOpen(event.target.value.trim().length >= 3);
                      }}
                      onFocus={() => {
                        if (activeBook === 'sundryCreditors' && accountSuggestions.length) setIsAccountSuggestionOpen(true);
                      }}
                      placeholder={activeBook === 'sundryCreditors' ? 'Search supplier / creditor account' : 'Search customer / debtor account'}
                    />
                    {activeBook === 'sundryCreditors' && isAccountSuggestionOpen && accountSuggestions.length > 0 && (
                      <div className="supplier-suggestions">
                        {accountSuggestions.map((match) => (
                          <button key={`${match.name}-${match.gstin}`} type="button" className="supplier-suggestion-row" onClick={() => selectCreditorAccount(match)}>
                            <strong>{match.name}</strong>
                            <span>{match.phone || '-'} | GSTIN {match.gstin || '-'} | A/C {match.bank_account_no || '-'}</span>
                          </button>
                        ))}
                      </div>
                    )}
                  </label>
                  <form className="voucher-entry-row" onSubmit={submitVoucher}>
                    <label>
                      <span className="field-label">Date</span>
                      <input className="field" type="date" value={voucherForm.voucher_date} onChange={(event) => updateVoucher('voucher_date', event.target.value)} required />
                    </label>
                    <label className="supplier-lookup-field">
                      <span className="field-label">{activeBook === 'sundryCreditors' ? 'Creditor Payment Account' : 'Debtor Receipt Account'}</span>
                      <input
                        className="field"
                        value={voucherForm.account_name}
                        onChange={(event) => {
                          updateVoucher('account_name', event.target.value);
                          if (activeBook === 'sundryCreditors') setAccountSearch(event.target.value);
                        }}
                        required
                      />
                    </label>
                    <label>
                      <span className="field-label">Mode</span>
                      <select className="select" value={voucherForm.payment_mode} onChange={(event) => updateVoucher('payment_mode', event.target.value)}>
                        <option value="Cash">Cash</option>
                        <option value="Bank">Bank</option>
                      </select>
                    </label>
                    <label>
                      <span className="field-label">Amount</span>
                      <input className="field" type="number" min="0" step="0.01" value={voucherForm.amount} onChange={(event) => updateVoucher('amount', event.target.value)} required />
                    </label>
                    {activeBook === 'sundryCreditors' && (
                      <>
                        <label>
                          <span className="field-label">Account Holder</span>
                          <input className="field" value={voucherForm.account_holder_name} onChange={(event) => updateVoucher('account_holder_name', event.target.value)} />
                        </label>
                        <label>
                          <span className="field-label">Bank</span>
                          <input className="field" value={voucherForm.bank_name} onChange={(event) => updateVoucher('bank_name', event.target.value)} />
                        </label>
                        <label>
                          <span className="field-label">Account No</span>
                          <input className="field" value={voucherForm.bank_account_no} onChange={(event) => updateVoucher('bank_account_no', event.target.value)} />
                        </label>
                        <label>
                          <span className="field-label">IFSC</span>
                          <input className="field" value={voucherForm.bank_ifsc} onChange={(event) => updateVoucher('bank_ifsc', event.target.value.toUpperCase())} />
                        </label>
                        <label>
                          <span className="field-label">UPI ID</span>
                          <input className="field" value={voucherForm.upi_id} onChange={(event) => updateVoucher('upi_id', event.target.value)} />
                        </label>
                      </>
                    )}
                    <label>
                      <span className="field-label">Ref No</span>
                      <input className="field" value={voucherForm.reference_no} onChange={(event) => updateVoucher('reference_no', event.target.value)} />
                    </label>
                    <label>
                      <span className="field-label">Remarks</span>
                      <input className="field" value={voucherForm.remarks} onChange={(event) => updateVoucher('remarks', event.target.value)} />
                    </label>
                    <button className="primary-button compact-primary" type="submit">
                      {activeBook === 'sundryCreditors' ? 'Save Payment' : 'Save Receipt'}
                    </button>
                  </form>
                </div>
              )}
              <div className={isCounterClosingCashAccountBook ? 'books-table-scroll cash-account-table-scroll' : 'books-table-scroll'}>
                <table className={isCounterClosingCashAccountBook ? 'history-table books-accounting-table cash-account-table' : 'history-table books-accounting-table'}>
                  <thead>
                    <tr>{activeReport.columns.map((column) => <th key={column}>{column}</th>)}</tr>
                  </thead>
                  <tbody>
                    {visibleRows.length === 0 ? (
                      <tr><td colSpan={activeReport.columns.length}>No entries for selected date range.</td></tr>
                    ) : visibleRows.map((row, index) => (
                      <tr key={`${activeBook}-${index}`}>
                        {activeReport.columns.map((column) => (
                          <td key={column}>
                            {activeBook === 'counterClosingSheets' && column === 'Action'
                              ? <button className="secondary-button" type="button" onClick={() => viewCounterClosingSheet(row)}>View</button>
                              : formatCell(row[column], column)}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {isCounterClosingCashAccountBook && (
                <form className="cash-account-entry-row" onSubmit={submitCashAccountEntry}>
                  <strong>Manual Entry Sheet</strong>
                  <label>
                    <span className="field-label">Date</span>
                    <input className="field" type="date" value={cashAccountEntryForm.entry_date} onChange={(event) => updateCashAccountEntry('entry_date', event.target.value)} required />
                  </label>
                  <label className="cash-account-details-field">
                    <span className="field-label">Details</span>
                    <input className="field" value={cashAccountEntryForm.details} onChange={(event) => updateCashAccountEntry('details', event.target.value)} placeholder="Cash purchase / HDFC deposit / expenses" required />
                  </label>
                  <label>
                    <span className="field-label">Counter</span>
                    <input className="field" type="number" min="1" max="99" step="1" value={cashAccountEntryForm.counter_no} onChange={(event) => updateCashAccountEntry('counter_no', event.target.value)} placeholder="C.No" />
                  </label>
                  <label>
                    <span className="field-label">DR Rs</span>
                    <input className="field" type="number" min="0" step="0.01" value={cashAccountEntryForm.dr_amount} onChange={(event) => updateCashAccountEntry('dr_amount', event.target.value)} placeholder="Cash added" />
                  </label>
                  <label>
                    <span className="field-label">CR Rs</span>
                    <input className="field" type="number" min="0" step="0.01" value={cashAccountEntryForm.cr_amount} onChange={(event) => updateCashAccountEntry('cr_amount', event.target.value)} placeholder="Cash used" />
                  </label>
                  <button className="primary-button compact-primary" type="submit">Post Entry</button>
                </form>
              )}
            </>
          )}
        </div>}
      </section>
    </div>
  );
}
