import React, { useEffect, useMemo, useState } from 'react';
import { fetchBooksSummary, fetchDayBook } from '../api/client';
import { todayIso } from '../utils/date';
import { formatMoney } from '../utils/money';

export default function BooksView() {
  const [date, setDate] = useState(todayIso());
  const [summary, setSummary] = useState(null);
  const [dayBook, setDayBook] = useState({ rows: [] });
  const [errorMessage, setErrorMessage] = useState('');

  useEffect(() => {
    loadBooks();
  }, []);

  async function loadBooks() {
    setErrorMessage('');
    try {
      const [summaryResult, dayBookResult] = await Promise.all([
        fetchBooksSummary(date),
        fetchDayBook(date)
      ]);
      setSummary(summaryResult);
      setDayBook(dayBookResult);
    } catch (err) {
      setErrorMessage(err.response?.data?.error || 'Unable to load books.');
    }
  }

  const cards = summary ? [
    ['Day Book', 'Sales and purchases for selected date', formatMoney((summary.dayBook.sales || 0) + (summary.dayBook.purchases || 0))],
    ['Cash Book', 'Cash receipts from sales', formatMoney(summary.cashBook.cashSales || 0)],
    ['Purchase Book', 'Inward purchase total', formatMoney(summary.purchaseBook.purchases || 0)],
    ['Tax Book', 'GST collected from sales', formatMoney(summary.taxBook.gstCollected || 0)],
    ['Profit & Loss', 'Estimated monthly gross result', formatMoney(summary.profitLoss.estimatedGrossProfit || 0)],
    ['Balance Sheet', summary.balanceSheet.inventoryNote, 'Stock Report']
  ] : [];

  const ledgerRows = useMemo(() => {
    const accounts = new Map();

    dayBook.rows.forEach((row) => {
      const accountName = row.account || (row.type === 'SALE' ? 'Walk-in Customer' : 'Supplier');
      const key = `${row.type}-${accountName}`;
      const current = accounts.get(key) || {
        account: accountName,
        type: row.type,
        entries: 0,
        sales: 0,
        purchases: 0,
        cash: 0,
        digital: 0
      };
      const amount = Number(row.amount || 0);
      current.entries += 1;
      if (row.type === 'SALE') current.sales += amount;
      if (row.type === 'PURCHASE') current.purchases += amount;
      if (row.mode === 'Cash') current.cash += amount;
      if (['UPI', 'Card'].includes(row.mode)) current.digital += amount;
      accounts.set(key, current);
    });

    return Array.from(accounts.values()).sort((a, b) => b.sales + b.purchases - (a.sales + a.purchases));
  }, [dayBook.rows]);

  return (
    <div className="form-stack">
      {errorMessage && <div className="alert-box">{errorMessage}</div>}
      <section className="panel">
        <div className="panel-header green">
          <h2 className="panel-title">Ledger Books</h2>
          <div className="report-filter-row">
            <input className="field" type="date" value={date} onChange={(event) => setDate(event.target.value)} />
            <button className="secondary-button" onClick={loadBooks}>Load</button>
          </div>
        </div>
        <div className="panel-body books-grid">
          {cards.map(([title, note, value]) => (
            <div className="module-card" key={title}>
              <strong>{title}</strong>
              <span className="muted">{note}</span>
              <span className="status-chip">{value}</span>
            </div>
          ))}
        </div>
      </section>

      <section className="panel">
        <div className="panel-header green"><h2 className="panel-title">Ledger Accounts</h2></div>
        <div className="panel-body">
          <table className="history-table">
            <thead><tr><th>Account</th><th>Ledger</th><th>Entries</th><th>Sales</th><th>Purchases</th><th>Cash</th><th>UPI/Card</th><th>Balance</th></tr></thead>
            <tbody>
              {ledgerRows.length === 0 ? (
                <tr><td colSpan="8">No ledger accounts for selected date.</td></tr>
              ) : ledgerRows.map((row) => {
                const balance = row.sales - row.purchases;
                return (
                  <tr key={`${row.type}-${row.account}`}>
                    <td><strong>{row.account}</strong></td>
                    <td>{row.type === 'SALE' ? 'Sales Ledger' : 'Purchase Ledger'}</td>
                    <td>{row.entries}</td>
                    <td>{formatMoney(row.sales)}</td>
                    <td>{formatMoney(row.purchases)}</td>
                    <td>{formatMoney(row.cash)}</td>
                    <td>{formatMoney(row.digital)}</td>
                    <td><strong className={balance < 0 ? 'stock-low' : ''}>{formatMoney(Math.abs(balance))}</strong></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      <section className="panel">
        <div className="panel-header green"><h2 className="panel-title">Day Book Entries</h2></div>
        <div className="panel-body">
          <table className="history-table">
            <thead><tr><th>Time</th><th>Type</th><th>Ref No</th><th>Account</th><th>Mode</th><th>Amount</th></tr></thead>
            <tbody>
              {dayBook.rows.length === 0 ? (
                <tr><td colSpan="6">No book entries for selected date.</td></tr>
              ) : dayBook.rows.map((row) => (
                <tr key={`${row.type}-${row.ref_no}`}>
                  <td>{row.created_at ? new Date(row.created_at).toLocaleTimeString() : '-'}</td>
                  <td>{row.type}</td>
                  <td className="mono">{row.ref_no}</td>
                  <td>{row.account}</td>
                  <td>{row.mode}</td>
                  <td><strong>{formatMoney(row.amount)}</strong></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
