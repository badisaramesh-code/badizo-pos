import React, { useEffect, useMemo, useState } from 'react';
import {
  fetchCounterClosingSummary,
  fetchCounterExpected,
  fetchSettings,
  getStoredUser,
  saveCounterClosing
} from '../api/client';
import { todayIso } from '../utils/date';
import { formatMoney, toNumber } from '../utils/money';

const DEFAULT_DENOMINATIONS = [2000, 500, 200, 100, 50, 20, 10, 5, 2, 1];

function parseJsonField(value, fallback) {
  if (!value) return fallback;
  if (typeof value === 'object') return value;

  try {
    return JSON.parse(value);
  } catch (err) {
    return fallback;
  }
}

function emptyDenominations(denominations) {
  return denominations.reduce((acc, value) => ({ ...acc, [value]: '' }), {});
}

function blankMovement() {
  return { type: 'OUT', reason: '', amount: '' };
}

export default function CounterClosingView() {
  const currentUser = getStoredUser();
  const isCounterUser = currentUser?.role === 'COUNTER';
  const userCounterNo = currentUser?.counter_no || 1;

  const [date, setDate] = useState(todayIso());
  const [counterNo, setCounterNo] = useState(userCounterNo);
  const [counterCount, setCounterCount] = useState(6);
  const [denominationList, setDenominationList] = useState(DEFAULT_DENOMINATIONS);
  const [denominations, setDenominations] = useState(emptyDenominations(DEFAULT_DENOMINATIONS));
  const [movements, setMovements] = useState([blankMovement()]);
  const [openingCash, setOpeningCash] = useState('');
  const [expected, setExpected] = useState({ Cash: 0, UPI: 0, Card: 0 });
  const [handedOverBy, setHandedOverBy] = useState(currentUser?.username || '');
  const [takenOverBy, setTakenOverBy] = useState('');
  const [notes, setNotes] = useState('');
  const [summary, setSummary] = useState({ rows: [], totals: {} });
  const [statusMessage, setStatusMessage] = useState('');
  const [errorMessage, setErrorMessage] = useState('');
  const [isSaving, setIsSaving] = useState(false);

  useEffect(() => {
    loadSettings();
  }, []);

  useEffect(() => {
    loadExpected();
    if (!isCounterUser) loadSummary();
  }, [date, counterNo]);

  const declaredCashTotal = useMemo(() => {
    return denominationList.reduce((sum, value) => {
      const count = Math.max(Number.parseInt(denominations[value], 10) || 0, 0);
      return sum + value * count;
    }, 0);
  }, [denominationList, denominations]);

  const cashInTotal = useMemo(() => {
    return movements
      .filter((movement) => movement.type === 'IN')
      .reduce((sum, movement) => sum + toNumber(movement.amount), 0);
  }, [movements]);

  const cashOutTotal = useMemo(() => {
    return movements
      .filter((movement) => movement.type === 'OUT')
      .reduce((sum, movement) => sum + toNumber(movement.amount), 0);
  }, [movements]);

  const expectedCashInHand = toNumber(openingCash) + toNumber(expected.Cash) + cashInTotal - cashOutTotal;
  const differenceAmount = declaredCashTotal - expectedCashInHand;

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

  async function loadExpected() {
    setErrorMessage('');
    setStatusMessage('');

    try {
      const result = await fetchCounterExpected(date, counterNo);
      const nextDenominations = result.denominations || DEFAULT_DENOMINATIONS;
      const closing = result.closing;
      setDenominationList(nextDenominations);
      setExpected(result.expected || { Cash: 0, UPI: 0, Card: 0 });

      if (closing) {
        setOpeningCash(String(toNumber(closing.opening_cash)));
        setDenominations({
          ...emptyDenominations(nextDenominations),
          ...parseJsonField(closing.denominations_json, {})
        });
        const savedMovements = parseJsonField(closing.movements_json, []);
        setMovements(savedMovements.length ? savedMovements : [blankMovement()]);
        setHandedOverBy(closing.handed_over_by || currentUser?.username || '');
        setTakenOverBy(closing.taken_over_by || '');
        setNotes(closing.notes || '');
        setStatusMessage('Existing closing loaded for this counter and date.');
      } else {
        setOpeningCash('');
        setDenominations(emptyDenominations(nextDenominations));
        setMovements([blankMovement()]);
        setHandedOverBy(currentUser?.username || '');
        setTakenOverBy('');
        setNotes('');
      }
    } catch (err) {
      setErrorMessage(err.response?.data?.error || 'Unable to load counter closing totals.');
    }
  }

  async function loadSummary() {
    try {
      setSummary(await fetchCounterClosingSummary(date));
    } catch (err) {
      setSummary({ rows: [], totals: {} });
    }
  }

  function updateMovement(index, field, value) {
    setMovements((current) => current.map((movement, rowIndex) => (
      rowIndex === index ? { ...movement, [field]: value } : movement
    )));
  }

  function removeMovement(index) {
    setMovements((current) => {
      const next = current.filter((_, rowIndex) => rowIndex !== index);
      return next.length ? next : [blankMovement()];
    });
  }

  async function handleSave() {
    setStatusMessage('');
    setErrorMessage('');

    if (!handedOverBy.trim() || !takenOverBy.trim()) {
      setErrorMessage('Enter both handover person and takeover person before saving.');
      return;
    }

    setIsSaving(true);
    try {
      const result = await saveCounterClosing({
        date,
        counter_no: counterNo,
        opening_cash: openingCash,
        denominations,
        movements,
        handed_over_by: handedOverBy,
        taken_over_by: takenOverBy,
        notes
      });
      setStatusMessage(`Counter ${result.counter_no} closing saved. Difference: ${formatMoney(result.difference_amount)}.`);
      await loadExpected();
      if (!isCounterUser) await loadSummary();
    } catch (err) {
      setErrorMessage(err.response?.data?.error || 'Unable to save counter closing.');
    } finally {
      setIsSaving(false);
    }
  }

  const counterOptions = Array.from({ length: counterCount }, (_, index) => index + 1);

  return (
    <div className="form-stack">
      {errorMessage && <div className="alert-box">{errorMessage}</div>}
      {statusMessage && <div className="change-box">{statusMessage}</div>}

      <section className="panel">
        <div className="panel-header green">
          <h2 className="panel-title">Counter Closing / Day Cash Handover</h2>
          <div className="report-filter-row closing-filter-row">
            <input className="field" type="date" value={date} onChange={(event) => setDate(event.target.value)} />
            <select
              className="select"
              value={counterNo}
              disabled={isCounterUser}
              onChange={(event) => setCounterNo(Number(event.target.value))}
            >
              {counterOptions.map((value) => <option key={value} value={value}>Counter {value}</option>)}
            </select>
            <button className="secondary-button" onClick={loadExpected}>Refresh</button>
          </div>
        </div>

        <div className="panel-body closing-layout">
          <div className="form-stack">
            <div className="closing-metrics">
              <div className="metric-card"><span className="muted">Cash Sales</span><strong>{formatMoney(expected.Cash)}</strong></div>
              <div className="metric-card"><span className="muted">UPI Sales</span><strong>{formatMoney(expected.UPI)}</strong></div>
              <div className="metric-card"><span className="muted">Card Sales</span><strong>{formatMoney(expected.Card)}</strong></div>
              <div className={`metric-card ${Math.abs(differenceAmount) > 0.01 ? 'variance-warning' : ''}`}>
                <span className="muted">Cash Difference</span>
                <strong>{formatMoney(differenceAmount)}</strong>
              </div>
            </div>

            <div className="summary-band closing-total-band">
              <div><span className="field-label">Opening Cash</span><input className="field" type="number" min="0" value={openingCash} onChange={(event) => setOpeningCash(event.target.value)} /></div>
              <div><span className="field-label">Cash In</span><strong>{formatMoney(cashInTotal)}</strong></div>
              <div><span className="field-label">Cash Out / Expenses</span><strong>{formatMoney(cashOutTotal)}</strong></div>
              <div><span className="field-label">Expected Cash In Hand</span><strong>{formatMoney(expectedCashInHand)}</strong></div>
              <div><span className="field-label">Declared Cash</span><strong>{formatMoney(declaredCashTotal)}</strong></div>
            </div>

            <section className="panel">
              <div className="panel-header"><h3 className="panel-title">Cash Denominations</h3></div>
              <div className="panel-body denomination-grid">
                {denominationList.map((value) => (
                  <label key={value}>
                    <span className="field-label">Rs. {value}</span>
                    <input
                      className="field"
                      type="number"
                      min="0"
                      value={denominations[value] || ''}
                      onChange={(event) => setDenominations((current) => ({ ...current, [value]: event.target.value }))}
                      placeholder="0"
                    />
                  </label>
                ))}
              </div>
            </section>
          </div>

          <div className="form-stack">
            <section className="panel">
              <div className="panel-header">
                <h3 className="panel-title">Money In / Out</h3>
                <button className="secondary-button" onClick={() => setMovements((current) => [...current, blankMovement()])}>Add Row</button>
              </div>
              <div className="panel-body">
                <table className="history-table">
                  <thead><tr><th>Type</th><th>Reason</th><th>Amount</th><th>Del</th></tr></thead>
                  <tbody>
                    {movements.map((movement, index) => (
                      <tr key={index}>
                        <td>
                          <select className="select" value={movement.type} onChange={(event) => updateMovement(index, 'type', event.target.value)}>
                            <option value="OUT">Cash Out</option>
                            <option value="IN">Cash In</option>
                          </select>
                        </td>
                        <td><input className="field" value={movement.reason} onChange={(event) => updateMovement(index, 'reason', event.target.value)} placeholder="Tea, loading, petty cash..." /></td>
                        <td><input className="field" type="number" min="0" value={movement.amount} onChange={(event) => updateMovement(index, 'amount', event.target.value)} /></td>
                        <td><button className="danger-button" onClick={() => removeMovement(index)}>Del</button></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>

            <section className="panel">
              <div className="panel-header"><h3 className="panel-title">Handover Details</h3></div>
              <div className="panel-body form-stack">
                <label><span className="field-label">Handed Over By</span><input className="field" value={handedOverBy} onChange={(event) => setHandedOverBy(event.target.value)} /></label>
                <label><span className="field-label">Taken Over By</span><input className="field" value={takenOverBy} onChange={(event) => setTakenOverBy(event.target.value)} /></label>
                <label><span className="field-label">Notes</span><input className="field" value={notes} onChange={(event) => setNotes(event.target.value)} placeholder="Optional closing note" /></label>
                <button className="primary-button" onClick={handleSave} disabled={isSaving}>{isSaving ? 'Saving...' : 'Save Counter Closing'}</button>
              </div>
            </section>
          </div>
        </div>
      </section>

      {!isCounterUser && (
        <section className="panel">
          <div className="panel-header green">
            <h2 className="panel-title">Daily Counter Closing Summary</h2>
            <button className="secondary-button" onClick={loadSummary}>Refresh Summary</button>
          </div>
          <div className="panel-body">
            <table className="history-table">
              <thead>
                <tr><th>Counter</th><th>Cash Sales</th><th>UPI</th><th>Card</th><th>Declared Cash</th><th>Difference</th><th>Handover</th></tr>
              </thead>
              <tbody>
                {summary.rows.length === 0 ? (
                  <tr><td colSpan="7">No counter closings saved for this date yet.</td></tr>
                ) : summary.rows.map((row) => (
                  <tr key={row.id}>
                    <td>Counter {row.counter_no}</td>
                    <td>{formatMoney(row.expected_cash_sales)}</td>
                    <td>{formatMoney(row.expected_upi_sales)}</td>
                    <td>{formatMoney(row.expected_card_sales)}</td>
                    <td><strong>{formatMoney(row.declared_cash_total)}</strong></td>
                    <td className={Math.abs(toNumber(row.difference_amount)) > 0.01 ? 'stock-low' : ''}>{formatMoney(row.difference_amount)}</td>
                    <td>{row.handed_over_by} to {row.taken_over_by}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <td><strong>Total</strong></td>
                  <td><strong>{formatMoney(summary.totals?.expectedCash)}</strong></td>
                  <td><strong>{formatMoney(summary.totals?.expectedUpi)}</strong></td>
                  <td><strong>{formatMoney(summary.totals?.expectedCard)}</strong></td>
                  <td><strong>{formatMoney(summary.totals?.declaredCash)}</strong></td>
                  <td><strong>{formatMoney(summary.totals?.difference)}</strong></td>
                  <td />
                </tr>
              </tfoot>
            </table>
          </div>
        </section>
      )}
    </div>
  );
}
