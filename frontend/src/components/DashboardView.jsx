import React, { useEffect, useMemo, useState } from 'react';
import { fetchDashboardReport } from '../api/client';
import { formatMoney } from '../utils/money';

const emptyReport = {
  today: { billCount: 0, salesTotal: 0, gstTotal: 0, averageBill: 0 },
  products: { totalProducts: 0, lowStockCount: 0 },
  counters: [],
  payments: [],
  topProducts: [],
  lowStock: []
};

export default function DashboardView({ setActiveWorkspace }) {
  const [report, setReport] = useState(emptyReport);
  const [errorMessage, setErrorMessage] = useState('');

  useEffect(() => {
    loadDashboard();
  }, []);

  async function loadDashboard() {
    setErrorMessage('');
    try {
      setReport(await fetchDashboardReport());
    } catch (err) {
      setErrorMessage(err.response?.data?.error || 'Unable to load dashboard from database.');
    }
  }

  const paymentTotal = useMemo(
    () => report.payments.reduce((sum, row) => sum + Number(row.salesTotal || 0), 0),
    [report.payments]
  );

  const metrics = [
    ['Today Sales', formatMoney(report.today.salesTotal), `${report.today.billCount} bills today`],
    ['Average Bill', formatMoney(report.today.averageBill), 'Per invoice'],
    ['Total Products', String(report.products.totalProducts), `${report.products.lowStockCount} low stock alerts`],
    ['GST Collected', formatMoney(report.today.gstTotal), 'CGST + SGST + IGST today']
  ];

  return (
    <div className="form-stack">
      {errorMessage && <div className="alert-box">{errorMessage}</div>}

      <section className="dashboard-grid">
        {metrics.map(([label, value, note]) => (
          <div className="metric-card" key={label}>
            <div className="muted">{label}</div>
            <span className="metric-value">{value}</span>
            <div className="muted">{note}</div>
          </div>
        ))}
      </section>

      <section className="report-grid">
        <div className="panel">
          <div className="panel-header green"><h2 className="panel-title">Counter-wise Sales</h2></div>
          <div className="panel-body">
            <table className="history-table">
              <tbody>
                {report.counters.length === 0 ? (
                  <tr><td>No bills today.</td></tr>
                ) : (
                  report.counters.map((row) => (
                    <tr key={row.counter}>
                      <td>{row.counter}</td>
                      <td>{row.billCount} bills</td>
                      <td><strong>{formatMoney(row.salesTotal)}</strong></td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>

        <div className="panel">
          <div className="panel-header green"><h2 className="panel-title">Top Products Today</h2></div>
          <div className="panel-body">
            <table className="history-table">
              <tbody>
                {report.topProducts.length === 0 ? (
                  <tr><td>No product sales today.</td></tr>
                ) : (
                  report.topProducts.map((row) => (
                    <tr key={row.productName}>
                      <td>{row.productName}</td>
                      <td>{row.quantity} qty</td>
                      <td>{formatMoney(row.salesTotal)}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>

        <div className="panel">
          <div className="panel-header green"><h2 className="panel-title">Payment Summary</h2></div>
          <div className="panel-body form-stack">
            {report.payments.length === 0 ? (
              <span className="muted">No payments today.</span>
            ) : (
              report.payments.map((row) => {
                const percent = paymentTotal ? Math.round((Number(row.salesTotal || 0) / paymentTotal) * 100) : 0;
                return (
                  <div key={row.mode}>
                    {row.mode}
                    <strong style={{ float: 'right' }}>{formatMoney(row.salesTotal)} ({percent}%)</strong>
                  </div>
                );
              })
            )}
            <button className="primary-button" onClick={() => setActiveWorkspace('billing')}>Open Billing</button>
          </div>
        </div>
      </section>

      <section className="panel">
        <div className="panel-header green">
          <h2 className="panel-title">Low Stock Alerts</h2>
          <button className="secondary-button" onClick={() => setActiveWorkspace('inward')}>Open Inward</button>
        </div>
        <div className="panel-body">
          <table className="history-table">
            <thead><tr><th>Product</th><th>Barcode</th><th>Stock</th><th>Minimum</th><th>Action</th></tr></thead>
            <tbody>
              {report.lowStock.length === 0 ? (
                <tr><td colSpan="5">No low stock products.</td></tr>
              ) : (
                report.lowStock.map((row) => (
                  <tr key={row.barcode}>
                    <td>{row.productName}</td>
                    <td className="mono">{row.barcode}</td>
                    <td className="stock-low">{row.stockQty}</td>
                    <td>{row.minStockAlert}</td>
                    <td><button className="secondary-button" onClick={() => setActiveWorkspace('inward')}>Reorder</button></td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
