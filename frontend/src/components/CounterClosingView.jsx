import React, { useEffect, useMemo, useRef, useState } from 'react';
import * as XLSX from 'xlsx';
import {
  fetchCounterHandover,
  fetchCounterHandoverHistory,
  fetchSettings,
  getStoredUser,
  saveCounterHandover
} from '../api/client';
import { formatDisplayDate, normalizeDateInput, todayIso } from '../utils/date';
import { formatMoney, toNumber } from '../utils/money';

const DEFAULT_DENOMINATIONS = [2000, 500, 200, 100, 50, 20, 10, 5, 2, 1];
const HANDOVER_TRANSACTION_ROWS = 30;
const HANDOVER_PRINT_MANUAL_ROWS = 23;
const HANDOVER_PRINT_DENOMINATION_ROWS = 8;
const AUTO_ENTRY_DETAILS = new Set(['Counter Closing Cash', 'Today Sale']);
const EMPTY_SNAPSHOT = { counter_sales: 0, all_counter_sales: 0, cash_sales: 0, upi_sales: 0, card_sales: 0, other_sales: 0 };

function emptyDenominations(denominations) {
  return denominations.reduce((acc, value) => ({ ...acc, [value]: '' }), {});
}

function blankEntry(direction = 'CR') {
  return { entry_type: 'GENERAL', details: '', remarks: '', direction, amount: '' };
}

function isAutoEntry(entry) {
  return AUTO_ENTRY_DETAILS.has(String(entry.details || '').trim());
}

function isEntryFilled(entry) {
  return Boolean(String(entry.details || '').trim() || String(entry.remarks || '').trim() || normalizeAmount(entry.amount) > 0);
}

function normalizeEntryCount(rows) {
  const sourceRows = Array.isArray(rows) ? rows : [];
  const normalized = sourceRows.slice(0, HANDOVER_TRANSACTION_ROWS).map((entry) => ({
    ...blankEntry(entry.direction === 'DR' ? 'DR' : 'CR'),
    ...entry,
    details: entry.details || '',
    remarks: entry.remarks || '',
    amount: entry.amount === undefined || entry.amount === null ? '' : String(entry.amount)
  }));

  while (normalized.length < HANDOVER_TRANSACTION_ROWS) {
    normalized.push(blankEntry());
  }

  return normalized;
}

function normalizeAmount(value) {
  const amount = Number(value || 0);
  return Number.isFinite(amount) ? amount : 0;
}

function formatAmountInput(value) {
  const text = String(value ?? '').trim();
  if (!text) return '';
  return normalizeAmount(text).toFixed(2);
}

function getOrderedRange(fromDate, toDate) {
  return fromDate <= toDate ? { from: fromDate, to: toDate } : { from: toDate, to: fromDate };
}

function exportWorkbook(filename, sheets) {
  const workbook = XLSX.utils.book_new();
  sheets.forEach(({ name, rows }) => {
    const worksheet = XLSX.utils.json_to_sheet(rows.length ? rows : [{ Message: 'No data available' }]);
    XLSX.utils.book_append_sheet(workbook, worksheet, name.slice(0, 31));
  });
  XLSX.writeFile(workbook, filename);
}

function makeDefaultEntries() {
  return normalizeEntryCount([]);
}

function normalizeSnapshot(source) {
  const counterSales = toNumber(source?.counter_sales);
  const cashSales = toNumber(source?.cash_sales);
  const upiSales = toNumber(source?.upi_sales);
  const cardSales = toNumber(source?.card_sales);
  const explicitOther = source?.other_sales === undefined || source?.other_sales === null
    ? counterSales - cashSales - upiSales - cardSales
    : toNumber(source.other_sales);

  return {
    counter_sales: counterSales,
    all_counter_sales: toNumber(source?.all_counter_sales),
    cash_sales: cashSales,
    upi_sales: upiSales,
    card_sales: cardSales,
    other_sales: Math.max(explicitOther, 0)
  };
}

function moneyWords(amount) {
  const value = Math.round(Number(amount || 0));
  if (!value) return 'Zero Rupees Only';
  return `${new Intl.NumberFormat('en-IN').format(value)} Rupees Only`;
}

function formatDateTime(value) {
  if (!value) return '-';
  const parsed = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(parsed.getTime())) return String(value);
  return parsed.toLocaleString('en-IN', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: true
  });
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export default function CounterClosingView() {
  const currentUser = getStoredUser();
  const isCounterUser = currentUser?.role === 'COUNTER';
  const userCounterNo = currentUser?.counter_no || 1;

  const [date, setDate] = useState(todayIso());
  const [historyFrom, setHistoryFrom] = useState(todayIso());
  const [historyTo, setHistoryTo] = useState(todayIso());
  const [counterNo, setCounterNo] = useState(userCounterNo);
  const [counterCount, setCounterCount] = useState(6);
  const [shopName, setShopName] = useState('Hyper Fresh Mart LLP');
  const [sheetNo, setSheetNo] = useState('');
  const [sheetMeta, setSheetMeta] = useState({ created_at: '', updated_at: '' });
  const [snapshot, setSnapshot] = useState(EMPTY_SNAPSHOT);
  const [denominationList, setDenominationList] = useState(DEFAULT_DENOMINATIONS);
  const [denominations, setDenominations] = useState(emptyDenominations(DEFAULT_DENOMINATIONS));
  const [openingCash, setOpeningCash] = useState('');
  const [entries, setEntries] = useState([blankEntry()]);
  const [activeEntryIndex, setActiveEntryIndex] = useState(0);
  const [isExistingSheet, setIsExistingSheet] = useState(false);
  const [handedOverBy, setHandedOverBy] = useState('');
  const [takenOverBy, setTakenOverBy] = useState('');
  const [notes, setNotes] = useState('');
  const [history, setHistory] = useState({ rows: [] });
  const [statusMessage, setStatusMessage] = useState('');
  const [errorMessage, setErrorMessage] = useState('');
  const [isHandoverLoading, setIsHandoverLoading] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const entryDetailRefs = useRef([]);
  const historySectionRef = useRef(null);

  useEffect(() => {
    loadSettings();
  }, []);

  useEffect(() => {
    loadHandover();
    if (!isCounterUser) loadHistory();
  }, [date, counterNo]);

  const denominationRows = useMemo(() => {
    return denominationList.map((value) => {
      const qty = Math.max(Number(denominations[value]) || 0, 0);
      return { value, qty, amount: value * qty };
    });
  }, [denominationList, denominations]);

  const notesTotal = useMemo(() => {
    return denominationRows.reduce((sum, row) => sum + row.amount, 0);
  }, [denominationRows]);

  const enteredEntries = useMemo(() => (
    entries.filter((entry) => isEntryFilled(entry) && !isAutoEntry(entry))
  ), [entries]);

  const displayEntryRows = useMemo(() => {
    const indexedRows = entries.map((entry, index) => ({ entry, index }));
    if (isExistingSheet) {
      return indexedRows.filter(({ entry }) => isEntryFilled(entry) && !isAutoEntry(entry));
    }

    const start = Math.max(Math.min(activeEntryIndex - 2, HANDOVER_TRANSACTION_ROWS - 3), 0);
    return indexedRows.slice(start, start + 3);
  }, [activeEntryIndex, entries, isExistingSheet]);

  const entryTotals = useMemo(() => {
    return enteredEntries.reduce((acc, entry) => {
      const amount = normalizeAmount(entry.amount);
      if (entry.direction === 'DR') acc.dr += amount;
      else acc.cr += amount;
      return acc;
    }, { dr: 0, cr: 0 });
  }, [enteredEntries]);

  const autoClosingCash = toNumber(openingCash);
  const autoTodaySale = toNumber(snapshot.counter_sales);
  const autoLedgerRows = useMemo(() => ([
    { entry_type: 'CLOSING_BASE', details: 'Counter Closing Cash', remarks: 'Auto from opening cash', direction: 'CR', amount: autoClosingCash ? String(autoClosingCash) : '' },
    { entry_type: 'SALES', details: 'Today Sale', remarks: 'Auto counter sales total', direction: 'CR', amount: autoTodaySale ? String(autoTodaySale) : '' }
  ]), [autoClosingCash, autoTodaySale]);
  const drTotal = entryTotals.dr + notesTotal;
  const crTotal = entryTotals.cr + autoClosingCash + autoTodaySale;
  const varianceAmount = drTotal - crTotal;
  const cashBalance = notesTotal;
  const printableEntries = enteredEntries;
  const printableDenominationRows = useMemo(() => (
    denominationRows.filter((row) => row.qty > 0)
  ), [denominationRows]);
  const handoverPrintEntryRows = useMemo(() => {
    const rows = [
      {
        details: 'Counter open Cash',
        remarks: '',
        direction: 'DR',
        amount: autoClosingCash
      },
      ...printableEntries.map((entry) => ({
        details: entry.details,
        remarks: entry.remarks,
        direction: entry.direction,
        amount: normalizeAmount(entry.amount)
      }))
    ].slice(0, HANDOVER_PRINT_MANUAL_ROWS);

    while (rows.length < HANDOVER_PRINT_MANUAL_ROWS) {
      rows.push({ details: '', remarks: '', direction: '', amount: 0 });
    }

    return rows;
  }, [autoClosingCash, printableEntries]);
  const handoverPrintDenominationRows = useMemo(() => {
    const rows = printableDenominationRows.slice(0, HANDOVER_PRINT_DENOMINATION_ROWS);
    while (rows.length < HANDOVER_PRINT_DENOMINATION_ROWS) {
      rows.push({ value: '', qty: '', amount: 0 });
    }
    return rows;
  }, [printableDenominationRows]);
  const handoverPrintDrTotal = entryTotals.dr + autoClosingCash + notesTotal;
  const handoverPrintCrTotal = entryTotals.cr + autoClosingCash + autoTodaySale;
  const handoverPrintDifference = handoverPrintDrTotal - handoverPrintCrTotal;
  const handoverPrintDifferenceDr = handoverPrintDifference > 0.01 ? handoverPrintDifference : 0;
  const handoverPrintDifferenceCr = handoverPrintDifference < -0.01 ? Math.abs(handoverPrintDifference) : 0;
  const handoverPrintTallyTotal = Math.max(handoverPrintDrTotal, handoverPrintCrTotal);

  async function loadSettings() {
    try {
      const settings = await fetchSettings();
      const count = Math.max(Number.parseInt(settings.counter_count, 10) || 1, 1);
      setCounterCount(count);
      setShopName(settings.shop_name || 'Hyper Fresh Mart LLP');
      if (!isCounterUser && counterNo > count) setCounterNo(1);
    } catch (err) {
      setCounterCount(6);
    }
  }

  async function loadHandover(options = {}) {
    const { manual = false } = options;
    const saleDate = normalizeDateInput(date);
    if (saleDate !== date) setDate(saleDate);
    setStatusMessage('');
    setErrorMessage('');
    setIsHandoverLoading(true);
    try {
      const result = await fetchCounterHandover(saleDate, counterNo);
      const nextSnapshot = normalizeSnapshot(result.snapshot);
      const nextDenominations = result.denominations || DEFAULT_DENOMINATIONS;
      const savedSheet = result.sheet;
      setSheetNo(savedSheet?.sheet_no || result.sheet_no || '');
      setSheetMeta(savedSheet ? { created_at: savedSheet.created_at || '', updated_at: savedSheet.updated_at || '' } : { created_at: '', updated_at: '' });
      setSnapshot(savedSheet ? normalizeSnapshot(savedSheet) : nextSnapshot);
      setDenominationList(nextDenominations);

      if (savedSheet) {
        setOpeningCash(String(toNumber(savedSheet.opening_cash)));
        setEntries(normalizeEntryCount((savedSheet.entries || []).filter((entry) => !isAutoEntry(entry))));
        setActiveEntryIndex(0);
        setIsExistingSheet(true);
        setDenominations({
          ...emptyDenominations(nextDenominations),
          ...(savedSheet.denominations || []).reduce((acc, row) => ({ ...acc, [Number(row.denomination_value)]: String(toNumber(row.quantity)) }), {})
        });
        setHandedOverBy(savedSheet.handed_over_by || '');
        setTakenOverBy(savedSheet.taken_over_by || '');
        setNotes(savedSheet.notes || '');
        setStatusMessage('Existing handover sheet loaded for this counter and date.');
      } else {
        setOpeningCash('');
        setEntries(makeDefaultEntries());
        setActiveEntryIndex(0);
        setIsExistingSheet(false);
        setDenominations(emptyDenominations(nextDenominations));
        setHandedOverBy('');
        setTakenOverBy('');
        setNotes('');
        if (manual) {
          if (nextSnapshot.counter_sales > 0) {
            setStatusMessage('Sales details loaded for selected sale date and counter.');
          } else if (nextSnapshot.all_counter_sales > 0) {
            setStatusMessage(`No bills found for Counter ${counterNo} on ${formatDisplayDate(saleDate)}. All counters have sales for this date.`);
          } else {
            const latestBillDate = nextSnapshot.latest_invoice_date
              ? ` Latest bill date in this database is ${formatDisplayDate(nextSnapshot.latest_invoice_date)}.`
              : '';
            setStatusMessage(`No bills found for selected sale date ${formatDisplayDate(saleDate)}.${latestBillDate}`);
          }
        }
      }
    } catch (err) {
      setErrorMessage(err.response?.data?.error || 'Unable to load counter handover sheet.');
    } finally {
      setIsHandoverLoading(false);
    }
  }

  async function loadHistory() {
    const range = getOrderedRange(normalizeDateInput(historyFrom), normalizeDateInput(historyTo));
    try {
      setHistory(await fetchCounterHandoverHistory({ ...range, counterNo: counterNo || '' }));
    } catch (err) {
      setHistory({ rows: [] });
    }
  }

  async function viewSavedSheet(row) {
    setDate(normalizeDateInput(row.closing_date));
    setCounterNo(Number(row.counter_no));
    setStatusMessage(`Viewing sheet ${row.sheet_no}.`);
    window.setTimeout(() => {
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }, 0);
  }

  async function showOldSheets() {
    await loadHistory();
    window.setTimeout(() => {
      historySectionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, 0);
  }

  function updateEntry(index, field, value) {
    setActiveEntryIndex(index);
    if (isExistingSheet) setIsExistingSheet(false);
    setEntries((current) => current.map((entry, rowIndex) => (
      rowIndex === index ? { ...entry, [field]: value } : entry
    )));
  }

  function updateOpeningCash(value) {
    setOpeningCash(value);
  }

  function formatOpeningCash() {
    setOpeningCash((current) => formatAmountInput(current));
  }

  function formatEntryAmount(index) {
    setEntries((current) => current.map((entry, rowIndex) => (
      rowIndex === index ? { ...entry, amount: formatAmountInput(entry.amount) } : entry
    )));
  }

  function focusEntryDetails(index) {
    setActiveEntryIndex(index);
    window.setTimeout(() => {
      entryDetailRefs.current[index]?.focus();
      entryDetailRefs.current[index]?.select?.();
    }, 0);
  }

  function moveToNextEntryOnEnter(event, index) {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    formatEntryAmount(index);
    focusEntryDetails(Math.min(index + 1, HANDOVER_TRANSACTION_ROWS - 1));
  }

  function resetAccountingRows() {
    setEntries(makeDefaultEntries());
    setActiveEntryIndex(0);
    setIsExistingSheet(false);
  }

  function startCashEntry(direction, details) {
    const nextDetails = details || (direction === 'DR' ? 'Cash Outgoing' : 'Cash Incoming');
    const emptyIndex = entries.findIndex((entry) => !isEntryFilled(entry));
    const targetIndex = emptyIndex >= 0 ? emptyIndex : Math.min(activeEntryIndex + 1, HANDOVER_TRANSACTION_ROWS - 1);

    setEntries((current) => current.map((entry, rowIndex) => (
      rowIndex === targetIndex
        ? { ...entry, details: entry.details || nextDetails, direction, amount: entry.amount || '' }
        : entry
    )));
    setActiveEntryIndex(targetIndex);
    setIsExistingSheet(false);
    focusEntryDetails(targetIndex);
  }

  async function handleSave() {
    setStatusMessage('');
    setErrorMessage('');

    if (!handedOverBy.trim() || !takenOverBy.trim()) {
      setErrorMessage('Enter both handover person and checked/taken over person before saving.');
      return;
    }

    setIsSaving(true);
    try {
      const result = await saveCounterHandover({
        date: normalizeDateInput(date),
        counter_no: counterNo,
        opening_cash: openingCash,
        entries: [...enteredEntries, ...autoLedgerRows].map((entry, index) => ({ ...entry, line_no: index + 1 })),
        denominations,
        handed_over_by: handedOverBy,
        taken_over_by: takenOverBy,
        notes
      });
      setStatusMessage(`Sheet ${result.sheet_no} saved. Cash notes balance: ${formatMoney(result.cash_balance)}. Difference: ${formatMoney(result.variance_amount)}.`);
      await loadHandover();
      if (!isCounterUser) await loadHistory();
    } catch (err) {
      setErrorMessage(err.response?.data?.error || 'Unable to save counter handover sheet.');
    } finally {
      setIsSaving(false);
    }
  }

  function exportHandoverExcel() {
    const saleDate = normalizeDateInput(date);
    exportWorkbook(`badizo_counter_handover_${saleDate}_C${counterNo}.xlsx`, [
      {
        name: 'Handover Sheet',
        rows: printableEntries.map((entry, index) => ({
          Sno: index + 1,
          Details: entry.details,
          Remarks: entry.remarks,
          DR: entry.direction === 'DR' ? normalizeAmount(entry.amount) : '',
          CR: entry.direction === 'CR' ? normalizeAmount(entry.amount) : ''
        })).concat([
          { Sno: '', Details: 'Cash Notes Denomination Total', Remarks: '', DR: notesTotal, CR: '' },
          { Sno: '', Details: 'Counter Closing Cash', Remarks: 'Auto from opening cash', DR: '', CR: autoClosingCash },
          { Sno: '', Details: 'Today Sale', Remarks: 'Auto counter sales total', DR: '', CR: autoTodaySale },
          { Sno: '', Details: 'Counter Closing Total', Remarks: '', DR: drTotal, CR: crTotal }
        ])
      },
      {
        name: 'Denominations',
        rows: printableDenominationRows.map((row) => ({ Denomination: row.value, Quantity: row.qty, Amount: row.amount }))
      }
    ]);
  }

  function exportHistoryExcel() {
    const range = getOrderedRange(normalizeDateInput(historyFrom), normalizeDateInput(historyTo));
    exportWorkbook(`badizo_counter_handover_history_${range.from}_to_${range.to}.xlsx`, [
      {
        name: 'Handover History',
        rows: (history.rows || []).map((row) => ({
          Date: formatDisplayDate(row.closing_date),
          Counter: row.counter_no,
          Sheet: row.sheet_no,
          'Counter Sale': Number(row.counter_sales || 0),
          'All Counter Sale': Number(row.all_counter_sales || 0),
          DR: Number(row.dr_total || 0),
          CR: Number(row.cr_total || 0),
          'Cash Notes Balance': Number(row.cash_balance || 0),
          Difference: Number(row.variance_amount || 0),
          Handover: row.handed_over_by,
          Checked: row.taken_over_by,
          'Added At': formatDateTime(row.created_at),
          'Edited At': formatDateTime(row.updated_at)
        }))
      }
    ]);
  }

  function buildHandoverPrintHtml(mode) {
    const normalizedMode = mode === 'A4' ? 'A4' : 'Thermal';
    const printClass = normalizedMode === 'A4' ? 'printing-a4' : 'printing-thermal';
    if (normalizedMode === 'Thermal') {
      const entryRows = handoverPrintEntryRows.map((entry, index) => `
        <tr>
          <td>${index + 1}</td>
          <td>${escapeHtml(entry.details)}</td>
          <td>${escapeHtml(entry.remarks)}</td>
          <td>${entry.direction === 'DR' && normalizeAmount(entry.amount) ? normalizeAmount(entry.amount).toFixed(2) : ''}</td>
          <td>${entry.direction === 'CR' && normalizeAmount(entry.amount) ? normalizeAmount(entry.amount).toFixed(2) : ''}</td>
        </tr>
      `).join('');
      const denominationRowsMarkup = handoverPrintDenominationRows.map((row, index) => `
        <tr>
          <td>${25 + index}</td>
          <td></td>
          <td>${row.value ? `${Number(row.value).toFixed(0)} x ${escapeHtml(row.qty || 0)}` : ''}</td>
          <td>${row.amount ? row.amount.toFixed(2) : ''}</td>
          <td></td>
        </tr>
      `).join('');

      return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>Counter Closing Thermal</title>
  <style>
    @page { size: 80mm auto; margin: 0; }
    html, body {
      width: 80mm;
      margin: 0;
      padding: 0;
      background: #fff;
      color: #111;
      font-family: Arial, Helvetica, sans-serif;
    }
    .counter-sale-slip {
      display: block;
      width: 72mm;
      margin: 0;
      padding: 2mm 4mm 2mm 2mm;
      background: #fff;
      color: #111;
      font-size: 8px;
      line-height: 1.15;
    }
    h1 {
      margin: 0;
      padding: 2px;
      border: 1px solid #111;
      border-bottom: 0;
      font-size: 11px;
      line-height: 1.2;
      text-align: center;
      text-transform: lowercase;
    }
    .meta, .sale-row {
      display: grid;
      border: 1px solid #111;
      border-bottom: 0;
    }
    .meta { grid-template-columns: 1fr 1.7fr 0.7fr; }
    .sale-row { grid-template-columns: 1fr 1fr; }
    .meta > *, .sale-row > * {
      padding: 2px;
      border-right: 1px solid #111;
      text-align: center;
      font-size: 8px;
    }
    .meta > *:last-child, .sale-row > *:last-child { border-right: 0; }
    table {
      width: 100%;
      border-collapse: collapse;
      table-layout: fixed;
    }
    th, td {
      border: 1px solid #111;
      padding: 1px 2px;
      height: 13px;
      font-size: 7px;
      vertical-align: middle;
      word-break: break-word;
    }
    th:nth-child(1), td:nth-child(1) { width: 5mm; text-align: center; }
    th:nth-child(2), td:nth-child(2) { width: 22mm; }
    th:nth-child(3), td:nth-child(3) { width: 15mm; }
    th:nth-child(4), th:nth-child(5), td:nth-child(4), td:nth-child(5) { width: 10mm; text-align: right; }
    tfoot th { font-weight: 700; }
    .balance {
      padding: 5px 2px;
      text-align: center;
      font-size: 8px;
      line-height: 1.25;
    }
    .signatures {
      display: grid;
      grid-template-columns: 1fr 1fr 1fr;
      gap: 3px;
      margin-top: 8mm;
      font-size: 7px;
      text-align: center;
    }
  </style>
</head>
<body>
  <div class="counter-sale-slip">
    <h1>${escapeHtml(shopName)}</h1>
    <div class="meta">
      <span>Date : ${escapeHtml(formatDisplayDate(date))}</span>
      <strong>Counter Handover Daily Sheet</strong>
      <span>Counter : ${escapeHtml(counterNo)}</span>
    </div>
    <div class="sale-row">
      <strong>Counter ${escapeHtml(counterNo)} sale Rs. ${normalizeAmount(snapshot.counter_sales).toFixed(2)}</strong>
      <strong>All Counters sale Rs : ${normalizeAmount(snapshot.all_counter_sales).toFixed(2)}</strong>
    </div>
    <table>
      <thead><tr><th>Sno</th><th>Details</th><th>Remarks</th><th>DR Rs</th><th>CR Rs</th></tr></thead>
      <tbody>
        ${entryRows}
        <tr><td>24</td><td colspan="4"><strong>Notes Dinomination</strong></td></tr>
        ${denominationRowsMarkup}
        <tr><td>33</td><td>Counter Closing Cash</td><td></td><td></td><td>${autoClosingCash ? autoClosingCash.toFixed(2) : ''}</td></tr>
        <tr><td>34</td><td>To Day Sale</td><td></td><td></td><td>${autoTodaySale ? autoTodaySale.toFixed(2) : ''}</td></tr>
        <tr><td>35</td><td>Difference +/-</td><td></td><td>${handoverPrintDifferenceDr ? handoverPrintDifferenceDr.toFixed(2) : ''}</td><td>${handoverPrintDifferenceCr ? handoverPrintDifferenceCr.toFixed(2) : ''}</td></tr>
      </tbody>
      <tfoot><tr><th>36</th><th>Counter closing Total</th><th></th><th>${handoverPrintTallyTotal.toFixed(2)}</th><th>${handoverPrintTallyTotal.toFixed(2)}</th></tr></tfoot>
    </table>
    <div class="balance">
      <strong>To Day Cash Notes Count Onwords Balance Rs. ${cashBalance.toFixed(2)}</strong><br />
      <span>${escapeHtml(moneyWords(cashBalance))}</span>
    </div>
    <div class="signatures">
      <span>Recived Signature.</span>
      <span>Checked</span>
      <span>Counter Person Signature</span>
    </div>
  </div>
</body>
</html>`;
    }

    const sourceSheetMarkup = document.querySelector('.handover-print-sheet')?.outerHTML || '';
    const sheetMarkup = sourceSheetMarkup;
    const styleMarkup = Array.from(document.querySelectorAll('style, link[rel="stylesheet"]'))
      .map((node) => node.outerHTML)
      .join('\n');
    const thermalCss = normalizedMode === 'Thermal' ? `
      body.printing-handover.printing-thermal,
      body.printing-handover.printing-thermal #root,
      body.printing-handover.printing-thermal .handover-print-area {
        width: 80mm !important;
        min-width: 80mm !important;
        max-width: 80mm !important;
        margin: 0 !important;
        padding: 0 !important;
        overflow: visible !important;
        background: #fff !important;
      }
      body.printing-handover.printing-thermal .handover-print-sheet {
        width: 80mm !important;
        min-width: 80mm !important;
        max-width: 80mm !important;
        min-height: 0 !important;
        max-height: none !important;
        padding: 2mm !important;
        overflow: visible !important;
        font-size: 9px !important;
        line-height: 1.2 !important;
      }
      body.printing-handover.printing-thermal .handover-print-sheet h1 {
        font-size: 12px !important;
        line-height: 1.25 !important;
      }
      body.printing-handover.printing-thermal .handover-print-meta,
      body.printing-handover.printing-thermal .handover-print-sale-row {
        display: block !important;
      }
      body.printing-handover.printing-thermal .handover-print-meta > *,
      body.printing-handover.printing-thermal .handover-print-sale-row > * {
        display: block !important;
        padding: 2px 3px !important;
        border-right: 0 !important;
        border-bottom: 1px solid #111 !important;
        text-align: left !important;
      }
      body.printing-handover.printing-thermal .handover-print-sheet th,
      body.printing-handover.printing-thermal .handover-print-sheet td {
        height: auto !important;
        padding: 2px !important;
        font-size: 8px !important;
        word-break: break-word;
      }
      body.printing-handover.printing-thermal .handover-print-sheet th:nth-child(1),
      body.printing-handover.printing-thermal .handover-print-sheet td:nth-child(1) {
        width: 7mm !important;
      }
      body.printing-handover.printing-thermal .handover-print-sheet th:nth-child(4),
      body.printing-handover.printing-thermal .handover-print-sheet th:nth-child(5),
      body.printing-handover.printing-thermal .handover-print-sheet td:nth-child(4),
      body.printing-handover.printing-thermal .handover-print-sheet td:nth-child(5) {
        width: 13mm !important;
      }
      body.printing-handover.printing-thermal .handover-print-balance {
        gap: 3px !important;
        padding: 6px 2px !important;
        font-size: 10px !important;
      }
      body.printing-handover.printing-thermal .handover-signatures {
        margin-top: 8mm !important;
        gap: 3px !important;
        font-size: 8px !important;
      }
    ` : '';

    return `<!doctype html>
<html class="printing-handover ${printClass}">
<head>
  <meta charset="utf-8" />
  <title>Counter Closing Print</title>
  <base href="${window.location.origin}/" />
  ${styleMarkup}
  <style>
    html, body { margin: 0 !important; padding: 0 !important; background: #fff !important; }
    .handover-print-area { display: block !important; visibility: visible !important; }
    .handover-print-area * { visibility: visible !important; }
    ${thermalCss}
  </style>
</head>
<body class="printing-handover ${printClass}">
  <div class="print-area handover-print-area ${normalizedMode === 'A4' ? 'print-a4' : 'print-thermal'}">${sheetMarkup}</div>
</body>
</html>`;
  }

  async function printHandoverSheet(mode) {
    const normalizedMode = mode === 'A4' ? 'A4' : 'Thermal';
    if (window.badizoDesktop?.printThermalHtml && normalizedMode === 'Thermal') {
      try {
        await window.badizoDesktop.printThermalHtml({
          html: buildHandoverPrintHtml('Thermal'),
          widthMm: 80,
          feedMarginMm: 4
        });
        setStatusMessage('Counter closing sheet sent to thermal printer.');
        return;
      } catch (err) {
        setErrorMessage(err.message || 'Unable to print counter closing sheet on thermal printer.');
        return;
      }
    }

    if (window.badizoDesktop?.printHtml && normalizedMode === 'A4') {
      try {
        await window.badizoDesktop.printHtml({
          html: buildHandoverPrintHtml('A4'),
          mode: 'A4',
          silent: false
        });
        setStatusMessage('Counter closing sheet sent to A4 printer.');
        return;
      } catch (err) {
        setErrorMessage(err.message || 'Unable to print counter closing sheet on A4 printer.');
        return;
      }
    }

    const printClass = normalizedMode === 'A4' ? 'printing-a4' : 'printing-thermal';
    document.documentElement.classList.add('printing-handover', printClass);
    document.body.classList.add('printing-handover', printClass);
    window.setTimeout(() => {
      window.print();
      window.setTimeout(() => {
        document.body.classList.remove('printing-handover', printClass);
        document.documentElement.classList.remove('printing-handover', printClass);
      }, 500);
    }, 50);
  }

  const counterOptions = Array.from({ length: counterCount }, (_, index) => index + 1);

  return (
    <div className="form-stack counter-handover-view">
      {errorMessage && <div className="alert-box">{errorMessage}</div>}
      {statusMessage && <div className="change-box">{statusMessage}</div>}

      <section className="panel counter-handover-card">
        <div className="panel-header green">
          <h2 className="panel-title">Counter Handover Daily Sheet</h2>
          <div className="report-filter-row closing-filter-row">
            <button className="secondary-button" type="button" onClick={() => printHandoverSheet('Thermal')}>Thermal Print</button>
            <button className="secondary-button" type="button" onClick={() => printHandoverSheet('A4')}>A4 Print</button>
            <button className="secondary-button" type="button" onClick={exportHandoverExcel}>Export Excel</button>
            {!isCounterUser && <button className="secondary-button" type="button" onClick={showOldSheets}>Old Sheets</button>}
            <label className="date-range-field">
              <span className="field-label">Date</span>
              <input className="field report-date-input" type="date" value={normalizeDateInput(date)} onChange={(event) => setDate(normalizeDateInput(event.target.value))} />
            </label>
            <label>
              <span className="field-label">Counter</span>
              <select className="select" value={counterNo} disabled={isCounterUser} onChange={(event) => setCounterNo(Number(event.target.value))}>
                {counterOptions.map((value) => <option key={value} value={value}>Counter {value}</option>)}
              </select>
            </label>
            <button className="secondary-button" type="button" onClick={() => loadHandover({ manual: true })} disabled={isHandoverLoading}>{isHandoverLoading ? 'Viewing...' : 'View'}</button>
          </div>
        </div>

        <div className="panel-body form-stack">
          <div className="handover-heading">
            <strong>{shopName}</strong>
            <span className="handover-heading-title">Accounting DR / CR Transactions</span>
            <span className="handover-heading-chip">Sale Date: {formatDisplayDate(date)}</span>
            <span className="handover-heading-chip">Sheet: {sheetNo || '-'}</span>
            <span className="handover-heading-chip">Counter: {counterNo}</span>
            <span className="handover-heading-chip">Added: {formatDateTime(sheetMeta.created_at)}</span>
            <span className="handover-heading-chip">Edited: {formatDateTime(sheetMeta.updated_at)}</span>
          </div>

          <div className="handover-sales-strip">
            <div><span>Total Sale</span><strong>{formatMoney(snapshot.counter_sales)}</strong></div>
            <div><span>Cash Sale</span><strong>{formatMoney(snapshot.cash_sales)}</strong></div>
            <div><span>UPI Sale</span><strong>{formatMoney(snapshot.upi_sales)}</strong></div>
            <div><span>Card Sale</span><strong>{formatMoney(snapshot.card_sales)}</strong></div>
            <div><span>Other Sale</span><strong>{formatMoney(snapshot.other_sales)}</strong></div>
            <div><span>All Counters Sale</span><strong>{formatMoney(snapshot.all_counter_sales)}</strong></div>
          </div>

          <div className="handover-actions-row">
            <label>
              <span className="field-label">Opening Cash</span>
              <input className="field amount-field no-spinner" inputMode="decimal" value={openingCash} onChange={(event) => updateOpeningCash(event.target.value)} onBlur={formatOpeningCash} />
            </label>
            <label>
              <span className="field-label">Handed Over By</span>
              <input className="field" value={handedOverBy} onChange={(event) => setHandedOverBy(event.target.value)} />
            </label>
            <label>
              <span className="field-label">Checked / Taken By</span>
              <input className="field" value={takenOverBy} onChange={(event) => setTakenOverBy(event.target.value)} />
            </label>
            <button className="secondary-button" type="button" onClick={() => startCashEntry('CR')}>Cash In</button>
            <button className="secondary-button" type="button" onClick={() => startCashEntry('DR')}>Cash Out</button>
            <button className="secondary-button" type="button" onClick={() => startCashEntry('DR', 'Charges')}>Charges</button>
            <button className="secondary-button" type="button" onClick={resetAccountingRows}>Reset Rows From Sales</button>
          </div>

          <section className="panel">
            <div className="panel-body table-scroll">
              <table className="history-table handover-table">
                <thead><tr><th>Sno</th><th>Details</th><th>Remarks</th><th>DR Rs</th><th>CR Rs</th></tr></thead>
                <tbody>
                  {displayEntryRows.length === 0 && isExistingSheet ? (
                    <tr><td colSpan="5">No manual entries saved for this sheet.</td></tr>
                  ) : displayEntryRows.map(({ entry, index }) => (
                    <tr key={index}>
                      <td>{index + 1}</td>
                      <td>
                        <input
                          ref={(element) => { entryDetailRefs.current[index] = element; }}
                          className="field"
                          value={entry.details}
                          onFocus={() => setActiveEntryIndex(index)}
                          onChange={(event) => updateEntry(index, 'details', event.target.value)}
                          onKeyDown={(event) => {
                            if (event.key === 'Enter') {
                              event.preventDefault();
                              const remarksInput = event.currentTarget.closest('tr')?.querySelector('.handover-remarks-input');
                              remarksInput?.focus();
                            }
                          }}
                          placeholder="Type details..."
                        />
                      </td>
                      <td>
                        <input
                          className="field handover-remarks-input"
                          value={entry.remarks}
                          onFocus={() => setActiveEntryIndex(index)}
                          onChange={(event) => updateEntry(index, 'remarks', event.target.value)}
                          onKeyDown={(event) => {
                            if (event.key === 'Enter') {
                              event.preventDefault();
                              const drInput = event.currentTarget.closest('tr')?.querySelector('.handover-dr-input');
                              drInput?.focus();
                            }
                          }}
                          placeholder="Remarks"
                        />
                      </td>
                      <td>
                        <input
                          className="field amount-field handover-dr-input"
                          inputMode="decimal"
                          value={entry.direction === 'DR' ? entry.amount : ''}
                          onChange={(event) => updateEntry(index, 'amount', event.target.value)}
                          onBlur={() => formatEntryAmount(index)}
                          onFocus={() => {
                            setActiveEntryIndex(index);
                            updateEntry(index, 'direction', 'DR');
                          }}
                          onKeyDown={(event) => moveToNextEntryOnEnter(event, index)}
                        />
                      </td>
                      <td>
                        <input
                          className="field amount-field"
                          inputMode="decimal"
                          value={entry.direction === 'CR' ? entry.amount : ''}
                          onChange={(event) => updateEntry(index, 'amount', event.target.value)}
                          onBlur={() => formatEntryAmount(index)}
                          onFocus={() => {
                            setActiveEntryIndex(index);
                            updateEntry(index, 'direction', 'CR');
                          }}
                          onKeyDown={(event) => moveToNextEntryOnEnter(event, index)}
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <section className="panel">
            <div className="panel-header handover-denomination-header">
              <h3 className="panel-title">Notes Denomination</h3>
              <strong>Today Cash Notes Count Balance: {formatMoney(cashBalance)}</strong>
            </div>
            <div className="panel-body handover-denomination-grid">
              {denominationRows.map((row) => (
                <label key={row.value}>
                  <span className="field-label">Rs. {row.value}</span>
                  <input className="field" type="number" min="0" value={denominations[row.value] || ''} onChange={(event) => setDenominations((current) => ({ ...current, [row.value]: event.target.value }))} />
                  <strong>{formatMoney(row.amount)}</strong>
                </label>
              ))}
            </div>
          </section>

          <section className="panel">
            <div className="panel-header"><h3 className="panel-title">Automatic Closing Rows</h3></div>
            <div className="panel-body table-scroll">
              <table className="history-table handover-auto-table">
                <thead><tr><th>Details</th><th>Remarks</th><th>DR Rs</th><th>CR Rs</th></tr></thead>
                <tbody>
                  <tr>
                    <td>Counter Closing Cash</td>
                    <td>Automatically taken from Opening Cash</td>
                    <td></td>
                    <td><strong>{formatMoney(autoClosingCash)}</strong></td>
                  </tr>
                  <tr>
                    <td>Today Sale</td>
                    <td>Automatically taken from counter sales</td>
                    <td></td>
                    <td><strong>{formatMoney(autoTodaySale)}</strong></td>
                  </tr>
                  <tr>
                    <td><strong>Counter Closing Total</strong></td>
                    <td></td>
                    <td><strong>{formatMoney(drTotal)}</strong></td>
                    <td><strong>{formatMoney(crTotal)}</strong></td>
                  </tr>
                </tbody>
              </table>
            </div>
          </section>

          <div className="handover-total-strip">
            <div><span>Notes Cash Balance</span><strong>{formatMoney(cashBalance)}</strong></div>
            <div><span>Closing Cash</span><strong>{formatMoney(autoClosingCash)}</strong></div>
            <div><span>Today Sale</span><strong>{formatMoney(autoTodaySale)}</strong></div>
            <div><span>DR Total</span><strong>{formatMoney(drTotal)}</strong></div>
            <div><span>CR Total</span><strong>{formatMoney(crTotal)}</strong></div>
            <div className={Math.abs(varianceAmount) > 0.01 ? 'variance-warning' : ''}><span>Difference</span><strong>{formatMoney(varianceAmount)}</strong></div>
          </div>

          <label>
            <span className="field-label">Closing Notes</span>
            <input className="field" value={notes} onChange={(event) => setNotes(event.target.value)} placeholder="Optional remarks for this handover sheet" />
          </label>

          <div className="report-action-row">
            <button className="primary-button handover-save-button" type="button" onClick={handleSave} disabled={isSaving}>{isSaving ? 'Saving...' : 'Save Handover Sheet and Post Ledger'}</button>
          </div>
        </div>
      </section>

      {!isCounterUser && (
        <section className="panel" ref={historySectionRef}>
          <div className="panel-header green">
            <h2 className="panel-title">Daily Handover Sheets Ledger</h2>
            <form className="report-filter-row" onSubmit={(event) => { event.preventDefault(); loadHistory(); }}>
              <label className="date-range-field"><span className="field-label">From</span><input className="field report-date-input" type="date" value={normalizeDateInput(historyFrom)} onChange={(event) => setHistoryFrom(normalizeDateInput(event.target.value))} /></label>
              <label className="date-range-field"><span className="field-label">To</span><input className="field report-date-input" type="date" value={normalizeDateInput(historyTo)} onChange={(event) => setHistoryTo(normalizeDateInput(event.target.value))} /></label>
              <button className="secondary-button" type="submit">Load</button>
              <button className="secondary-button" type="button" onClick={exportHistoryExcel}>Export Excel</button>
            </form>
          </div>
          <div className="panel-body table-scroll">
            <table className="history-table">
              <thead><tr><th>Sale Date</th><th>Counter</th><th>Sheet</th><th>Sale</th><th>DR</th><th>CR</th><th>Cash Notes Balance</th><th>Difference</th><th>Handover</th><th>Added</th><th>Edited</th><th>Action</th></tr></thead>
              <tbody>
                {(history.rows || []).length === 0 ? (
                  <tr><td colSpan="12">No handover sheets saved for selected date range.</td></tr>
                ) : history.rows.map((row) => (
                  <tr key={row.id}>
                    <td>{formatDisplayDate(row.closing_date)}</td>
                    <td>Counter {row.counter_no}</td>
                    <td className="mono">{row.sheet_no}</td>
                    <td>{formatMoney(row.counter_sales)}</td>
                    <td>{formatMoney(row.dr_total)}</td>
                    <td>{formatMoney(row.cr_total)}</td>
                    <td><strong>{formatMoney(row.cash_balance)}</strong></td>
                    <td className={Math.abs(toNumber(row.variance_amount)) > 0.01 ? 'stock-low' : ''}>{formatMoney(row.variance_amount)}</td>
                    <td>{row.handed_over_by} to {row.taken_over_by}</td>
                    <td>{formatDateTime(row.created_at)}</td>
                    <td>{formatDateTime(row.updated_at)}</td>
                    <td><button className="secondary-button" type="button" onClick={() => viewSavedSheet(row)}>View</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      <div className="print-area handover-print-area print-a4 print-thermal">
        <div className="handover-print-sheet">
          <h1>{shopName}</h1>
          <div className="handover-print-meta">
            <span>Date : {formatDisplayDate(date)}</span>
            <strong>Counter Handover Daily Sheet</strong>
            <span>Counter: {counterNo}</span>
          </div>
          <div className="handover-print-sale-row">
            <strong>Counter {counterNo} sale Rs. {normalizeAmount(snapshot.counter_sales).toFixed(2)}</strong>
            <strong>All Counters sale Rs : {normalizeAmount(snapshot.all_counter_sales).toFixed(2)}</strong>
          </div>
          <table>
            <thead><tr><th>Sno</th><th>Details</th><th>Remarks</th><th>DR Rs</th><th>CR Rs</th></tr></thead>
            <tbody>
              {handoverPrintEntryRows.map((entry, index) => (
                <tr key={index}>
                  <td>{index + 1}</td>
                  <td>{entry.details}</td>
                  <td>{entry.remarks}</td>
                  <td>{entry.direction === 'DR' && normalizeAmount(entry.amount) ? normalizeAmount(entry.amount).toFixed(2) : ''}</td>
                  <td>{entry.direction === 'CR' && normalizeAmount(entry.amount) ? normalizeAmount(entry.amount).toFixed(2) : ''}</td>
                </tr>
              ))}
              <tr><td>24</td><td colSpan="4"><strong>Notes Dinomination</strong></td></tr>
              {handoverPrintDenominationRows.map((row, index) => (
                <tr key={`${row.value || 'blank'}-${index}`}>
                  <td>{25 + index}</td>
                  <td></td>
                  <td>{row.value ? `${Number(row.value).toFixed(0)} x ${row.qty || 0}` : ''}</td>
                  <td>{row.amount ? row.amount.toFixed(2) : ''}</td>
                  <td></td>
                </tr>
              ))}
              <tr><td>33</td><td>Counter Closing Cash</td><td></td><td></td><td>{autoClosingCash ? autoClosingCash.toFixed(2) : ''}</td></tr>
              <tr><td>34</td><td>To Day Sale</td><td></td><td></td><td>{autoTodaySale ? autoTodaySale.toFixed(2) : ''}</td></tr>
              <tr><td>35</td><td>Difference +/-</td><td></td><td>{handoverPrintDifferenceDr ? handoverPrintDifferenceDr.toFixed(2) : ''}</td><td>{handoverPrintDifferenceCr ? handoverPrintDifferenceCr.toFixed(2) : ''}</td></tr>
            </tbody>
            <tfoot>
              <tr><th>36</th><th>Counter closing Total</th><th></th><th>{handoverPrintTallyTotal.toFixed(2)}</th><th>{handoverPrintTallyTotal.toFixed(2)}</th></tr>
            </tfoot>
          </table>
          <div className="handover-print-balance">
            <strong>Today Cash Notes Count Onwards Balance Rs. {cashBalance.toFixed(2)}</strong>
            <span>{moneyWords(cashBalance)}</span>
          </div>
          <div className="handover-signatures">
            <span>Received Signature.</span>
            <span>Checked</span>
            <span>Counter Person Signature</span>
          </div>
        </div>
      </div>
    </div>
  );
}
