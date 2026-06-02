import React, { useEffect, useMemo, useRef, useState } from 'react';
import * as XLSX from 'xlsx';
import {
  fetchCounterHandover,
  fetchCounterHandoverHistory,
  fetchSettings,
  getStoredUser,
  saveCounterHandover
} from '../api/client';
import { todayIso } from '../utils/date';
import { formatMoney, toNumber } from '../utils/money';

const DEFAULT_DENOMINATIONS = [2000, 500, 200, 100, 50, 20, 10, 5, 2, 1];
const HANDOVER_TRANSACTION_ROWS = 30;
const AUTO_ENTRY_DETAILS = new Set(['Counter Closing Cash', 'Today Sale']);

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

function moneyWords(amount) {
  const value = Math.round(Number(amount || 0));
  if (!value) return 'Zero Rupees Only';
  return `${new Intl.NumberFormat('en-IN').format(value)} Rupees Only`;
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
  const [sheetNo, setSheetNo] = useState('');
  const [snapshot, setSnapshot] = useState({ counter_sales: 0, all_counter_sales: 0, cash_sales: 0, upi_sales: 0, card_sales: 0 });
  const [denominationList, setDenominationList] = useState(DEFAULT_DENOMINATIONS);
  const [denominations, setDenominations] = useState(emptyDenominations(DEFAULT_DENOMINATIONS));
  const [openingCash, setOpeningCash] = useState('');
  const [entries, setEntries] = useState([blankEntry()]);
  const [activeEntryIndex, setActiveEntryIndex] = useState(0);
  const [isExistingSheet, setIsExistingSheet] = useState(false);
  const [handedOverBy, setHandedOverBy] = useState(currentUser?.username || '');
  const [takenOverBy, setTakenOverBy] = useState('');
  const [notes, setNotes] = useState('');
  const [history, setHistory] = useState({ rows: [] });
  const [statusMessage, setStatusMessage] = useState('');
  const [errorMessage, setErrorMessage] = useState('');
  const [isSaving, setIsSaving] = useState(false);
  const entryDetailRefs = useRef([]);

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

  async function loadSettings() {
    try {
      const settings = await fetchSettings();
      const count = Math.max(Number.parseInt(settings.counter_count, 10) || 1, 1);
      setCounterCount(count);
      if (!isCounterUser && counterNo > count) setCounterNo(1);
    } catch (err) {
      setCounterCount(6);
    }
  }

  async function loadHandover() {
    setStatusMessage('');
    setErrorMessage('');
    try {
      const result = await fetchCounterHandover(date, counterNo);
      const nextSnapshot = result.snapshot || {};
      const nextDenominations = result.denominations || DEFAULT_DENOMINATIONS;
      const savedSheet = result.sheet;
      setSheetNo(savedSheet?.sheet_no || result.sheet_no || '');
      setSnapshot(nextSnapshot);
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
        setHandedOverBy(savedSheet.handed_over_by || currentUser?.username || '');
        setTakenOverBy(savedSheet.taken_over_by || '');
        setNotes(savedSheet.notes || '');
        setStatusMessage('Existing handover sheet loaded for this counter and date.');
      } else {
        setOpeningCash('');
        setEntries(makeDefaultEntries());
        setActiveEntryIndex(0);
        setIsExistingSheet(false);
        setDenominations(emptyDenominations(nextDenominations));
        setHandedOverBy(currentUser?.username || '');
        setTakenOverBy('');
        setNotes('');
      }
    } catch (err) {
      setErrorMessage(err.response?.data?.error || 'Unable to load counter handover sheet.');
    }
  }

  async function loadHistory() {
    const range = getOrderedRange(historyFrom, historyTo);
    try {
      setHistory(await fetchCounterHandoverHistory({ ...range, counterNo: counterNo || '' }));
    } catch (err) {
      setHistory({ rows: [] });
    }
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
        date,
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
    exportWorkbook(`badizo_counter_handover_${date}_C${counterNo}.xlsx`, [
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
    const range = getOrderedRange(historyFrom, historyTo);
    exportWorkbook(`badizo_counter_handover_history_${range.from}_to_${range.to}.xlsx`, [
      {
        name: 'Handover History',
        rows: (history.rows || []).map((row) => ({
          Date: row.closing_date,
          Counter: row.counter_no,
          Sheet: row.sheet_no,
          'Counter Sale': Number(row.counter_sales || 0),
          'All Counter Sale': Number(row.all_counter_sales || 0),
          DR: Number(row.dr_total || 0),
          CR: Number(row.cr_total || 0),
          'Cash Notes Balance': Number(row.cash_balance || 0),
          Difference: Number(row.variance_amount || 0),
          Handover: row.handed_over_by,
          Checked: row.taken_over_by
        }))
      }
    ]);
  }

  function printHandoverSheet() {
    document.body.classList.add('printing-handover');
    window.setTimeout(() => {
      window.print();
      window.setTimeout(() => {
        document.body.classList.remove('printing-handover');
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
            <button className="secondary-button" type="button" onClick={printHandoverSheet}>Print Sheet</button>
            <button className="secondary-button" type="button" onClick={exportHandoverExcel}>Export Excel</button>
            <label className="date-range-field">
              <span className="field-label">Date</span>
              <input className="field report-date-input" type="date" value={date} onChange={(event) => setDate(event.target.value)} />
            </label>
            <label>
              <span className="field-label">Counter</span>
              <select className="select" value={counterNo} disabled={isCounterUser} onChange={(event) => setCounterNo(Number(event.target.value))}>
                {counterOptions.map((value) => <option key={value} value={value}>Counter {value}</option>)}
              </select>
            </label>
            <button className="secondary-button" type="button" onClick={loadHandover}>Refresh</button>
          </div>
        </div>

        <div className="panel-body form-stack">
          <div className="handover-heading">
            <strong>Hyper Fresh Mart LLP</strong>
            <span className="handover-heading-title">Accounting DR / CR Transactions</span>
            <span className="handover-heading-chip">Date: {date}</span>
            <span className="handover-heading-chip">Sheet: {sheetNo || '-'}</span>
            <span className="handover-heading-chip">Counter: {counterNo}</span>
          </div>

          <div className="handover-sales-strip">
            <div><span>Counter {counterNo} Sale</span><strong>{formatMoney(snapshot.counter_sales)}</strong></div>
            <div><span>All Counters Sale</span><strong>{formatMoney(snapshot.all_counter_sales)}</strong></div>
            <div><span>Cash</span><strong>{formatMoney(snapshot.cash_sales)}</strong></div>
            <div><span>UPI</span><strong>{formatMoney(snapshot.upi_sales)}</strong></div>
            <div><span>Card</span><strong>{formatMoney(snapshot.card_sales)}</strong></div>
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
        <section className="panel">
          <div className="panel-header green">
            <h2 className="panel-title">Daily Handover Sheets Ledger</h2>
            <form className="report-filter-row" onSubmit={(event) => { event.preventDefault(); loadHistory(); }}>
              <label className="date-range-field"><span className="field-label">From</span><input className="field report-date-input" type="date" value={historyFrom} onChange={(event) => setHistoryFrom(event.target.value)} /></label>
              <label className="date-range-field"><span className="field-label">To</span><input className="field report-date-input" type="date" value={historyTo} onChange={(event) => setHistoryTo(event.target.value)} /></label>
              <button className="secondary-button" type="submit">Load</button>
              <button className="secondary-button" type="button" onClick={exportHistoryExcel}>Export Excel</button>
            </form>
          </div>
          <div className="panel-body table-scroll">
            <table className="history-table">
              <thead><tr><th>Date</th><th>Counter</th><th>Sheet</th><th>Sale</th><th>DR</th><th>CR</th><th>Cash Notes Balance</th><th>Difference</th><th>Handover</th></tr></thead>
              <tbody>
                {(history.rows || []).length === 0 ? (
                  <tr><td colSpan="9">No handover sheets saved for selected date range.</td></tr>
                ) : history.rows.map((row) => (
                  <tr key={row.id}>
                    <td>{row.closing_date}</td>
                    <td>Counter {row.counter_no}</td>
                    <td className="mono">{row.sheet_no}</td>
                    <td>{formatMoney(row.counter_sales)}</td>
                    <td>{formatMoney(row.dr_total)}</td>
                    <td>{formatMoney(row.cr_total)}</td>
                    <td><strong>{formatMoney(row.cash_balance)}</strong></td>
                    <td className={Math.abs(toNumber(row.variance_amount)) > 0.01 ? 'stock-low' : ''}>{formatMoney(row.variance_amount)}</td>
                    <td>{row.handed_over_by} to {row.taken_over_by}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      <div className="print-area handover-print-area">
        <div className="handover-print-sheet">
          <h1>hyper fresh mart llp</h1>
          <div className="handover-print-meta">
            <span>Date: {date}</span>
            <strong>Counter Handover Daily Sheet</strong>
            <span>Counter: {counterNo}</span>
          </div>
          <div className="handover-print-sale-row">
            <strong>Counter {counterNo} sale Rs: {normalizeAmount(snapshot.counter_sales).toFixed(2)}</strong>
            <strong>All Counters sale Rs: {normalizeAmount(snapshot.all_counter_sales).toFixed(2)}</strong>
          </div>
          <table>
            <thead><tr><th>Sno</th><th>Details</th><th>Remarks</th><th>DR Rs</th><th>CR Rs</th></tr></thead>
            <tbody>
              {printableEntries.map((entry, index) => (
                <tr key={index}>
                  <td>{index + 1}</td>
                  <td>{entry.details}</td>
                  <td>{entry.remarks}</td>
                  <td>{entry.direction === 'DR' ? normalizeAmount(entry.amount).toFixed(2) : ''}</td>
                  <td>{entry.direction === 'CR' ? normalizeAmount(entry.amount).toFixed(2) : ''}</td>
                </tr>
              ))}
              <tr><td>{printableEntries.length + 1}</td><td colSpan="4"><strong>Notes Denomination</strong></td></tr>
              {printableDenominationRows.map((row, index) => (
                <tr key={row.value}><td>{printableEntries.length + 2 + index}</td><td>Rs. {row.value}</td><td>{row.qty || ''}</td><td>{row.amount ? row.amount.toFixed(2) : ''}</td><td /></tr>
              ))}
              <tr><td>{printableEntries.length + printableDenominationRows.length + 2}</td><td>Counter Closing Cash</td><td>Auto from opening cash</td><td></td><td>{autoClosingCash.toFixed(2)}</td></tr>
              <tr><td>{printableEntries.length + printableDenominationRows.length + 3}</td><td>Today Sale</td><td>Auto counter sales total</td><td></td><td>{autoTodaySale.toFixed(2)}</td></tr>
            </tbody>
            <tfoot>
              <tr><th colSpan="3">Counter Closing Total</th><th>{drTotal.toFixed(2)}</th><th>{crTotal.toFixed(2)}</th></tr>
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
