import React, { useEffect, useMemo, useState } from 'react';
import {
  exportDailySalesReport,
  fetchDailySalesReport,
  fetchExceptionReport,
  fetchGstHsnReport,
  fetchMonthlySalesReport,
  fetchStockReport,
  fetchTaxSummaryReport,
  fetchTopProductsReport
} from '../api/client';
import { formatMoney } from '../utils/money';

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

export default function ReportsView() {
  const [date, setDate] = useState(todayIso());
  const [counter, setCounter] = useState('');
  const [dailyReport, setDailyReport] = useState({ rows: [], totals: { billCount: 0, itemCount: 0, taxable: 0, gst: 0, total: 0 } });
  const [hsnReport, setHsnReport] = useState({ rows: [] });
  const [monthlyReport, setMonthlyReport] = useState({ rows: [] });
  const [stockReport, setStockReport] = useState([]);
  const [topProducts, setTopProducts] = useState({ rows: [] });
  const [taxSummary, setTaxSummary] = useState({ rows: [] });
  const [exceptionReport, setExceptionReport] = useState({ cancelled: [], returns: [] });
  const [errorMessage, setErrorMessage] = useState('');

  useEffect(() => {
    loadReports();
  }, []);

  async function loadReports() {
    setErrorMessage('');
    try {
      const [daily, hsn, monthly, stock, top, tax, exceptions] = await Promise.all([
        fetchDailySalesReport({ date, counter }),
        fetchGstHsnReport({ from: date, to: date }),
        fetchMonthlySalesReport(date.slice(0, 7)),
        fetchStockReport(false),
        fetchTopProductsReport({ from: date, to: date }),
        fetchTaxSummaryReport({ from: date, to: date }),
        fetchExceptionReport({ from: date, to: date })
      ]);
      setDailyReport(daily);
      setHsnReport(hsn);
      setMonthlyReport(monthly);
      setStockReport(stock);
      setTopProducts(top);
      setTaxSummary(tax);
      setExceptionReport(exceptions);
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
          ['Monthly Sales', `${monthlyReport.rows.length} trading days`],
          ['Stock Report', `${stockReport.length} products loaded`],
          ['Top Products', `${topProducts.rows.length} products`],
          ['Tax Summary', `${taxSummary.rows.length} GST slabs`],
          ['Returns', `${exceptionReport.returns.length} returns`],
          ['Cancelled Bills', `${exceptionReport.cancelled.length} cancelled`]
        ].map(([title, note]) => (
          <div className="module-card" key={title}>
            <strong>{title}</strong>
            <span className="muted">{note}</span>
          </div>
        ))}
      </section>

      <section className="panel">
        <div className="panel-header green"><h2 className="panel-title">Monthly Sales</h2></div>
        <div className="panel-body">
          <table className="history-table">
            <thead><tr><th>Date</th><th>Bills</th><th>Taxable</th><th>GST</th><th>Total</th></tr></thead>
            <tbody>
              {monthlyReport.rows.length === 0 ? (
                <tr><td colSpan="5">No monthly sales data.</td></tr>
              ) : monthlyReport.rows.map((row) => (
                <tr key={row.sale_date}>
                  <td>{row.sale_date ? new Date(row.sale_date).toLocaleDateString() : '-'}</td>
                  <td>{row.bill_count}</td>
                  <td>{formatMoney(row.taxable)}</td>
                  <td>{formatMoney(row.gst)}</td>
                  <td><strong>{formatMoney(row.total)}</strong></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="panel">
        <div className="panel-header green"><h2 className="panel-title">Top Products / Tax / Exceptions</h2></div>
        <div className="panel-body report-grid">
          <div>
            <h3 className="panel-title">Top Products</h3>
            <table className="history-table">
              <tbody>
                {topProducts.rows.slice(0, 8).map((row) => (
                  <tr key={row.barcode}><td>{row.product_name}</td><td>{row.quantity}</td><td>{formatMoney(row.total)}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
          <div>
            <h3 className="panel-title">Tax Wise</h3>
            <table className="history-table">
              <tbody>
                {taxSummary.rows.map((row) => (
                  <tr key={row.gst_percent}><td>{Number(row.gst_percent)}%</td><td>{formatMoney(row.gross_total)}</td><td>{formatMoney(Number(row.cgst || 0) + Number(row.sgst || 0) + Number(row.igst || 0))}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
          <div>
            <h3 className="panel-title">Exceptions</h3>
            <table className="history-table">
              <tbody>
                <tr><td>Returns</td><td>{exceptionReport.returns.length}</td></tr>
                <tr><td>Cancelled Bills</td><td>{exceptionReport.cancelled.length}</td></tr>
                <tr><td>Low Stock</td><td>{stockReport.filter((row) => Number(row.stock_qty) <= Number(row.min_stock_alert)).length}</td></tr>
              </tbody>
            </table>
          </div>
        </div>
      </section>
    </div>
  );
}
