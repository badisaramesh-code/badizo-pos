import React, { useEffect, useMemo, useState } from 'react';
import { exportDailySalesReport, fetchDailySalesReport, fetchGstHsnReport } from '../api/client';
import { formatMoney } from '../utils/money';

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

export default function ReportsView() {
  const [date, setDate] = useState(todayIso());
  const [counter, setCounter] = useState('');
  const [dailyReport, setDailyReport] = useState({ rows: [], totals: { billCount: 0, itemCount: 0, taxable: 0, gst: 0, total: 0 } });
  const [hsnReport, setHsnReport] = useState({ rows: [] });
  const [errorMessage, setErrorMessage] = useState('');

  useEffect(() => {
    loadReports();
  }, []);

  async function loadReports() {
    setErrorMessage('');
    try {
      const [daily, hsn] = await Promise.all([
        fetchDailySalesReport({ date, counter }),
        fetchGstHsnReport({ from: date, to: date })
      ]);
      setDailyReport(daily);
      setHsnReport(hsn);
    } catch (err) {
      setErrorMessage(err.response?.data?.error || 'Unable to load reports from database.');
    }
  }

  const counterOptions = useMemo(() => {
    const names = dailyReport.rows.map((row) => row.billing_counter).filter(Boolean);
    return [...new Set(names)].sort();
  }, [dailyReport.rows]);

  const metricCards = [
    ['Bills', dailyReport.totals.billCount || 0, 'Selected date'],
    ['Taxable', formatMoney(dailyReport.totals.taxable || 0), 'Sales before GST'],
    ['GST', formatMoney(dailyReport.totals.gst || 0), 'Collected tax'],
    ['Total Sales', formatMoney(dailyReport.totals.total || 0), 'Grand total']
  ];

  return (
    <div className="form-stack">
      {errorMessage && <div className="alert-box">{errorMessage}</div>}

      <section className="dashboard-grid">
        {metricCards.map(([label, value, note]) => (
          <div className="metric-card" key={label}>
            <div className="muted">{label}</div>
            <span className="metric-value">{value}</span>
            <div className="muted">{note}</div>
          </div>
        ))}
      </section>

      <section className="panel">
        <div className="panel-header green"><h2 className="panel-title">Daily Sales Report</h2></div>
        <div className="panel-body form-stack">
          <div className="report-filter-row">
            <input className="field" type="date" value={date} onChange={(event) => setDate(event.target.value)} />
            <select className="select" value={counter} onChange={(event) => setCounter(event.target.value)}>
              <option value="">All Counters</option>
              {counterOptions.map((option) => (
                <option key={option} value={option}>{option}</option>
              ))}
            </select>
            <button className="secondary-button" onClick={loadReports}>Filter</button>
            <button className="secondary-button" onClick={() => window.print()}>Print</button>
            <button className="secondary-button" onClick={() => exportDailySalesReport({ date, counter })}>Export CSV</button>
          </div>

          <table className="history-table">
            <thead>
              <tr>
                <th>Invoice No</th>
                <th>Time</th>
                <th>Customer</th>
                <th>Items</th>
                <th>Taxable</th>
                <th>GST</th>
                <th>Total</th>
                <th>Mode</th>
                <th>Counter</th>
              </tr>
            </thead>
            <tbody>
              {dailyReport.rows.length === 0 ? (
                <tr><td colSpan="9">No invoices found for selected date.</td></tr>
              ) : (
                dailyReport.rows.map((row) => (
                  <tr key={row.invoice_no}>
                    <td className="mono">{row.invoice_no}</td>
                    <td>{row.bill_time}</td>
                    <td>{row.customer_name || 'Walk-in Customer'}</td>
                    <td>{row.item_count}</td>
                    <td>{formatMoney(row.sub_total)}</td>
                    <td>{formatMoney(row.gst_total)}</td>
                    <td><strong>{formatMoney(row.grand_total)}</strong></td>
                    <td>{row.payment_mode}</td>
                    <td>{row.billing_counter}</td>
                  </tr>
                ))
              )}
            </tbody>
            <tfoot>
              <tr>
                <th>Total</th>
                <th></th>
                <th></th>
                <th>{dailyReport.totals.itemCount || 0}</th>
                <th>{formatMoney(dailyReport.totals.taxable || 0)}</th>
                <th>{formatMoney(dailyReport.totals.gst || 0)}</th>
                <th>{formatMoney(dailyReport.totals.total || 0)}</th>
                <th></th>
                <th></th>
              </tr>
            </tfoot>
          </table>
        </div>
      </section>

      <section className="panel">
        <div className="panel-header green"><h2 className="panel-title">GST HSN-wise Summary</h2></div>
        <div className="panel-body">
          <table className="history-table">
            <thead>
              <tr>
                <th>HSN</th>
                <th>GST %</th>
                <th>Qty</th>
                <th>Gross</th>
                <th>CGST</th>
                <th>SGST</th>
                <th>IGST</th>
              </tr>
            </thead>
            <tbody>
              {hsnReport.rows.length === 0 ? (
                <tr><td colSpan="7">No GST data for selected date.</td></tr>
              ) : (
                hsnReport.rows.map((row) => (
                  <tr key={`${row.hsn_code}-${row.gst_percent}`}>
                    <td>{row.hsn_code || '-'}</td>
                    <td>{Number(row.gst_percent || 0)}%</td>
                    <td>{Number(row.quantity || 0)}</td>
                    <td>{formatMoney(row.gross_total)}</td>
                    <td>{formatMoney(row.cgst)}</td>
                    <td>{formatMoney(row.sgst)}</td>
                    <td>{formatMoney(row.igst)}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>

      <section className="report-grid">
        {[
          ['Monthly Sales', 'Next: month-wise report with export'],
          ['GSTR-1 Report', 'Next: GST filing format'],
          ['Top/Low Products', 'Next: date-range movement report'],
          ['Sundry Debtors', 'Next: credit customer ledger'],
          ['Sundry Creditors', 'Next: supplier balance'],
          ['Staff Attendance & Salary', 'Next: employee module']
        ].map(([title, note]) => (
          <div className="module-card" key={title}>
            <strong>{title}</strong>
            <span className="muted">{note}</span>
          </div>
        ))}
      </section>
    </div>
  );
}
