import React, { useEffect, useMemo, useState } from 'react';
import * as XLSX from 'xlsx';
import {
  fetchCounterCashLedger,
  fetchSettings,
  saveCounterCashLedgerEntry
} from '../api/client';
import { formatDisplayDate, normalizeDateInput, todayIso } from '../utils/date';
import { formatMoney, toNumber } from '../utils/money';

const blankEntry = {
  date: todayIso(),
  counter_no: '',
  details: '',
  cr_amount: '',
  dr_amount: ''
};

function formatAmount(value) {
  const text = String(value ?? '').trim();
  if (!text) return '';
  return toNumber(text).toFixed(2);
}

function formatSheetAmount(value) {
  const amount = toNumber(value);
  return amount ? amount.toFixed(2) : '';
}

function parseDenominationDetails(value) {
  return String(value || '')
    .split(',')
    .map((part) => {
      const match = part.trim().match(/^(\d+(?:\.\d+)?)\s*x\s*(\d+(?:\.\d+)?)/i);
      if (!match) return null;
      const denomination = Number(match[1]);
      const quantity = Number(match[2]);
      if (!Number.isFinite(denomination) || !Number.isFinite(quantity)) return null;
      return {
        noteDetail: `${denomination}x${quantity}`,
        amount: denomination * quantity
      };
    })
    .filter(Boolean);
}

function exportWorkbook(filename, rows) {
  const workbook = XLSX.utils.book_new();
  const worksheet = XLSX.utils.json_to_sheet(rows.length ? rows : [{ Message: 'No data available' }]);
  XLSX.utils.book_append_sheet(workbook, worksheet, 'Cash Ledger');
  XLSX.writeFile(workbook, filename);
}

function normalizeCounterValue(value) {
  const match = String(value || '').match(/(\d+)/);
  return match ? match[1] : '';
}

export default function CounterCashLedgerView({ initialFrom = '', initialTo = '', initialCounter = '' } = {}) {
  const [from, setFrom] = useState(normalizeDateInput(initialFrom || todayIso()));
  const [to, setTo] = useState(normalizeDateInput(initialTo || todayIso()));
  const [counterNo, setCounterNo] = useState(normalizeCounterValue(initialCounter));
  const [counterCount, setCounterCount] = useState(6);
  const [ledger, setLedger] = useState({ rows: [], totals: {}, opening_balance: 0, closing_balance: 0 });
  const [manualEntry, setManualEntry] = useState(blankEntry);
  const [statusMessage, setStatusMessage] = useState('');
  const [errorMessage, setErrorMessage] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [isSaving, setIsSaving] = useState(false);

  useEffect(() => {
    loadSettings();
    loadLedger();
  }, []);

  useEffect(() => {
    const nextCounter = normalizeCounterValue(initialCounter);
    if (nextCounter) {
      setCounterNo(nextCounter);
      setManualEntry((current) => ({ ...current, counter_no: nextCounter }));
    }
  }, [initialCounter]);

  useEffect(() => {
    if (initialFrom) {
      const nextFrom = normalizeDateInput(initialFrom);
      setFrom(nextFrom);
      setManualEntry((current) => ({ ...current, date: nextFrom }));
    }
    if (initialTo) setTo(normalizeDateInput(initialTo));
  }, [initialFrom, initialTo]);

  const counterOptions = useMemo(() => (
    Array.from({ length: counterCount }, (_, index) => index + 1)
  ), [counterCount]);

  const rows = Array.isArray(ledger.rows) ? ledger.rows : [];
  const sheetRows = useMemo(() => {
    let balance = toNumber(ledger.opening_balance);
    const expandedRows = [];

    rows.forEach((row) => {
      const isCounterCash = row.source_type === 'COUNTER_HANDOVER' && row.payment_mode === 'CASH_NOTES';
      const denominations = isCounterCash ? parseDenominationDetails(row.denomination_details) : [];

      if (denominations.length > 0) {
        denominations.forEach((denomination, index) => {
          balance += denomination.amount;
          expandedRows.push({
            key: `${row.id}-${index}`,
            date: index === 0 ? row.entry_date : '',
            details: index === 0 ? `COUNTER ${row.counter_no || ''} SALE`.trim() : '',
            noteDetail: denomination.noteDetail,
            dr: denomination.amount,
            cr: 0,
            balance,
            balanceType: balance >= 0 ? 'Dr' : 'Cr'
          });
        });
        return;
      }

      const dr = toNumber(row.dr_amount);
      const cr = toNumber(row.cr_amount);
      balance += dr - cr;
      expandedRows.push({
        key: row.id,
        date: row.entry_date,
        details: row.details,
        noteDetail: '',
        dr,
        cr,
        balance,
        balanceType: balance >= 0 ? 'Dr' : 'Cr'
      });
    });

    return expandedRows;
  }, [ledger.opening_balance, rows]);

  async function loadSettings() {
    try {
      const settings = await fetchSettings();
      setCounterCount(Math.max(Number.parseInt(settings.counter_count, 10) || 1, 1));
    } catch (err) {
      setCounterCount(6);
    }
  }

  async function loadLedger(options = {}) {
    const nextFrom = normalizeDateInput(from);
    const nextTo = normalizeDateInput(to);
    setFrom(nextFrom);
    setTo(nextTo);
    setIsLoading(true);
    setStatusMessage('');
    setErrorMessage('');
    try {
      const result = await fetchCounterCashLedger({ from: nextFrom, to: nextTo, counterNo });
      setLedger(result);
      if (options.manual) setStatusMessage('Cash ledger loaded.');
    } catch (err) {
      setErrorMessage(err.response?.data?.error || 'Unable to load cash ledger.');
      setLedger({ rows: [], totals: {}, opening_balance: 0, closing_balance: 0 });
    } finally {
      setIsLoading(false);
    }
  }

  function updateManualEntry(field, value) {
    setManualEntry((current) => {
      const next = { ...current, [field]: value };
      if (field === 'cr_amount' && value) next.dr_amount = '';
      if (field === 'dr_amount' && value) next.cr_amount = '';
      return next;
    });
  }

  function updateManualCounter(value) {
    const nextCounter = normalizeCounterValue(value);
    setCounterNo(nextCounter);
    setManualEntry((current) => ({ ...current, counter_no: nextCounter }));
  }

  async function handleManualSubmit(event) {
    event.preventDefault();
    setStatusMessage('');
    setErrorMessage('');
    setIsSaving(true);
    try {
      await saveCounterCashLedgerEntry({
        date: normalizeDateInput(manualEntry.date),
        counter_no: manualEntry.counter_no || counterNo || '',
        details: manualEntry.details,
        cr_amount: manualEntry.cr_amount,
        dr_amount: manualEntry.dr_amount
      });
      setManualEntry((current) => ({
        ...blankEntry,
        date: normalizeDateInput(current.date),
        counter_no: current.counter_no
      }));
      setStatusMessage('Manual cash ledger entry saved.');
      await loadLedger();
    } catch (err) {
      setErrorMessage(err.response?.data?.error || 'Unable to save manual cash entry.');
    } finally {
      setIsSaving(false);
    }
  }

  function exportLedgerExcel() {
    const exportRows = [
      {
        Date: '',
        Details: 'Opening Balance',
        Counter: counterNo ? `Counter ${counterNo}` : 'All Counters',
        'DR Rs': '',
        'CR Rs': '',
        'Cash Balance': toNumber(ledger.opening_balance)
      },
      ...sheetRows.map((row) => ({
        Date: row.date,
        Details: row.details,
        'Note Detail': row.noteDetail,
        'DR Rs': toNumber(row.dr) || '',
        'CR Rs': toNumber(row.cr) || '',
        'Balance Rs': toNumber(row.balance),
        'dr/cr': row.balanceType
      }))
    ];
    exportWorkbook(`badizo_cash_ledger_${normalizeDateInput(from)}_${normalizeDateInput(to)}.xlsx`, exportRows);
  }

  return (
    <div className="form-stack counter-cash-ledger-view">
      {errorMessage && <div className="alert-box">{errorMessage}</div>}
      {statusMessage && <div className="change-box">{statusMessage}</div>}

      <section className="panel cash-ledger-panel">
        <div className="panel-header green">
          <h2 className="panel-title">Counter Cash Ledger Sheet</h2>
          <form className="report-filter-row cash-ledger-filter-row" onSubmit={(event) => { event.preventDefault(); loadLedger({ manual: true }); }}>
            <label className="date-range-field">
              <span className="field-label">From</span>
              <input className="field report-date-input" type="date" value={normalizeDateInput(from)} onChange={(event) => setFrom(normalizeDateInput(event.target.value))} />
            </label>
            <label className="date-range-field">
              <span className="field-label">To</span>
              <input className="field report-date-input" type="date" value={normalizeDateInput(to)} onChange={(event) => setTo(normalizeDateInput(event.target.value))} />
            </label>
            <label>
              <span className="field-label">Counter</span>
              <select className="select" value={counterNo} onChange={(event) => setCounterNo(event.target.value)}>
                <option value="">All</option>
                {counterOptions.map((value) => <option key={value} value={String(value)}>Counter {value}</option>)}
              </select>
            </label>
            <button className="secondary-button" type="submit" disabled={isLoading}>{isLoading ? 'Loading...' : 'View'}</button>
            <button className="secondary-button" type="button" onClick={exportLedgerExcel}>Export Excel</button>
          </form>
        </div>

        <div className="panel-body cash-ledger-body">
          <div className="handover-total-strip cash-ledger-summary">
            <div><span>Opening Balance</span><strong>{formatMoney(ledger.opening_balance)}</strong></div>
            <div><span>Total DR</span><strong>{formatMoney(ledger.totals?.dr)}</strong></div>
            <div><span>Total CR</span><strong>{formatMoney(ledger.totals?.cr)}</strong></div>
            <div><span>Cash Balance</span><strong>{formatMoney(ledger.closing_balance)}</strong></div>
          </div>

          <div className="cash-ledger-scroll">
            <table className="history-table cash-ledger-table">
              <thead>
                <tr className="cash-ledger-title-row">
                  <th colSpan="7">COUNTER CLOSING CASH ACCOUNT</th>
                </tr>
                <tr>
                  <th>DATE</th>
                  <th>DETAILES</th>
                  <th>NOTE DETAILE</th>
                  <th>DR Rs</th>
                  <th>CR Rs</th>
                  <th>Balance Rs</th>
                  <th>dr/cr</th>
                </tr>
              </thead>
              <tbody>
                {sheetRows.length === 0 ? (
                  <tr><td colSpan="7">No cash ledger rows for selected date range.</td></tr>
                ) : sheetRows.map((row) => (
                  <tr key={row.key}>
                    <td>{row.date ? formatDisplayDate(row.date) : ''}</td>
                    <td>{row.details}</td>
                    <td>{row.noteDetail}</td>
                    <td>{formatSheetAmount(row.dr)}</td>
                    <td>{formatSheetAmount(row.cr)}</td>
                    <td>{toNumber(row.balance).toFixed(2)}</td>
                    <td>{row.balanceType}</td>
                  </tr>
                ))}
                {Array.from({ length: Math.max(18 - sheetRows.length, 4) }, (_, index) => (
                  <tr key={`blank-${index}`} className="cash-ledger-blank-row">
                    <td></td><td></td><td></td><td></td><td></td><td>{index === 0 && sheetRows.length ? toNumber(sheetRows[sheetRows.length - 1].balance).toFixed(2) : ''}</td><td></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </section>

      <form className="cash-ledger-entry-bar" onSubmit={handleManualSubmit}>
        <table className="cash-ledger-manual-table">
          <thead>
            <tr><th colSpan="4">MANUAEL ENTRY SHEET</th></tr>
            <tr><th>DATE</th><th>DETAILES</th><th>DR Rs</th><th>CR rs</th></tr>
          </thead>
          <tbody>
            <tr>
              <td><input className="field" type="date" value={normalizeDateInput(manualEntry.date)} onChange={(event) => updateManualEntry('date', normalizeDateInput(event.target.value))} /></td>
              <td>
                <div className="cash-ledger-manual-details">
                  <select className="select" value={manualEntry.counter_no} onChange={(event) => updateManualCounter(event.target.value)}>
                    <option value="">-</option>
                    {counterOptions.map((value) => <option key={value} value={String(value)}>Counter {value}</option>)}
                  </select>
                  <input className="field" value={manualEntry.details} onChange={(event) => updateManualEntry('details', event.target.value)} placeholder="CASH PURCHASE / HDFC / BANK DEPOSIT" />
                </div>
              </td>
              <td><input className="field amount-field" inputMode="decimal" value={manualEntry.dr_amount} onChange={(event) => updateManualEntry('dr_amount', event.target.value)} onBlur={() => updateManualEntry('dr_amount', formatAmount(manualEntry.dr_amount))} /></td>
              <td><input className="field amount-field" inputMode="decimal" value={manualEntry.cr_amount} onChange={(event) => updateManualEntry('cr_amount', event.target.value)} onBlur={() => updateManualEntry('cr_amount', formatAmount(manualEntry.cr_amount))} /></td>
            </tr>
          </tbody>
        </table>
        <button className="primary-button cash-ledger-post-button" type="submit" disabled={isSaving}>{isSaving ? 'Saving...' : 'Post Entry'}</button>
      </form>
    </div>
  );
}
