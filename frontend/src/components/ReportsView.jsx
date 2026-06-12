import React, { useEffect, useMemo, useState } from 'react';
import * as XLSX from 'xlsx';
import {
  exportDailySalesReport,
  fetchBarcodePrintLogs,
  fetchCounterHandoverReport,
  fetchDailySalesReport,
  fetchExchangeBillsReport,
  fetchExceptionReport,
  fetchGstHsnReport,
  fetchGstr1Report,
  fetchMonthlySalesReport,
  fetchReprintReport,
  fetchStockReport,
  fetchTaxSummaryReport,
  fetchTopProductsReport
} from '../api/client';
import { todayIso } from '../utils/date';
import { formatMoney } from '../utils/money';

function formatCompactMoney(value) {
  const amount = Number(value || 0);
  if (Math.abs(amount) >= 10000000) return `Rs. ${(amount / 10000000).toFixed(2)} Cr`;
  if (Math.abs(amount) >= 100000) return `Rs. ${(amount / 100000).toFixed(2)} L`;
  return `Rs. ${amount.toFixed(2)}`;
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

function reportFileName(name, from, to) {
  return `badizo_${name}_${from}_to_${to}.xlsx`;
}

function ReportHeader({ title, onExcel, onPdf }) {
  return (
    <div className="panel-header green">
      <h2 className="panel-title">{title}</h2>
      <div className="report-header-actions">
        <button className="header-print-button report-print-trigger" type="button">Print Report</button>
        <button className="header-print-button" type="button" onClick={onExcel}>Export Excel</button>
        <button className="header-print-button" type="button" onClick={onPdf}>Export PDF</button>
      </div>
    </div>
  );
}

export default function ReportsView({ isActive = true, onClose }) {
  const [activeReport, setActiveReport] = useState('daily');
  const [fromDate, setFromDate] = useState(todayIso());
  const [toDate, setToDate] = useState(todayIso());
  const [counter, setCounter] = useState('');
  const [reportSearch, setReportSearch] = useState('');
  const [dailyReport, setDailyReport] = useState({
    rows: [],
    totals: {
      billCount: 0,
      itemCount: 0,
      taxable: 0,
      gst: 0,
      saleTotal: 0,
      exchangeBillCount: 0,
      exchangeSaleTotal: 0,
      exchangeLess: 0,
      exchangeNetTotal: 0,
      total: 0
    }
  });
  const [hsnReport, setHsnReport] = useState({ rows: [] });
  const [monthlyReport, setMonthlyReport] = useState({ rows: [] });
  const [stockReport, setStockReport] = useState([]);
  const [topProducts, setTopProducts] = useState({ rows: [] });
  const [taxSummary, setTaxSummary] = useState({ rows: [] });
  const [gstr1Report, setGstr1Report] = useState({ b2b: [], b2cl: [], b2c: [], hsn: [], hsnB2b: [], hsnB2c: [], nilExempt: [], documents: {}, totals: {} });
  const [counterHandoverReport, setCounterHandoverReport] = useState({ rows: [], totals: {} });
  const [exceptionReport, setExceptionReport] = useState({ cancelled: [], returns: [] });
  const [exchangeReport, setExchangeReport] = useState({ rows: [], totals: {} });
  const [barcodePrintReport, setBarcodePrintReport] = useState({ rows: [], totals: {} });
  const [reprintReport, setReprintReport] = useState({ rows: [], totals: {} });
  const [errorMessage, setErrorMessage] = useState('');

  useEffect(() => {
    loadReports();
  }, []);

  useEffect(() => {
    if (isActive) loadReports();
  }, [isActive]);

  async function loadReports() {
    setErrorMessage('');
    const { from, to } = getOrderedRange(fromDate, toDate);
    try {
      const [daily, hsn, monthly, stock, top, tax, gstr1, handover, exceptions, exchange, barcodePrints, reprints] = await Promise.all([
        fetchDailySalesReport({ from, to, counter }),
        fetchGstHsnReport({ from, to }),
        fetchMonthlySalesReport(from.slice(0, 7)),
        fetchStockReport(false),
        fetchTopProductsReport({ from, to }),
        fetchTaxSummaryReport({ from, to }),
        fetchGstr1Report({ from, to }),
        fetchCounterHandoverReport({ from, to, counter }),
        fetchExceptionReport({ from, to }),
        fetchExchangeBillsReport({ from, to, counter }),
        fetchBarcodePrintLogs({ from, to, search: reportSearch }),
        fetchReprintReport({ from, to, counter, search: reportSearch })
      ]);
      setDailyReport(daily);
      setHsnReport(hsn);
      setMonthlyReport(monthly);
      setStockReport(stock);
      setTopProducts(top);
      setTaxSummary(tax);
      setGstr1Report(gstr1);
      setCounterHandoverReport(handover);
      setExceptionReport(exceptions);
      setExchangeReport(exchange);
      setBarcodePrintReport(barcodePrints);
      setReprintReport(reprints);
    } catch (err) {
      setErrorMessage(err.response?.data?.error || 'Unable to load reports from database.');
    }
  }

  function handleReportFilterSubmit(event) {
    event.preventDefault();
    loadReports();
  }

  function printReport() {
    document.documentElement.classList.add('printing-reports');
    document.body.classList.add('printing-reports');
    window.print();
    setTimeout(() => {
      document.body.classList.remove('printing-reports');
      document.documentElement.classList.remove('printing-reports');
    }, 300);
  }

  function exportPdf() {
    printReport();
  }

  const counterOptions = useMemo(() => {
    const names = dailyReport.rows.map((row) => row.billing_counter).filter(Boolean);
    return [...new Set(names)].sort();
  }, [dailyReport.rows]);

  const reportOptions = [
    { key: 'daily', title: 'Daily Sales', note: `${dailyReport.totals.billCount || 0} bills` },
    { key: 'hsn', title: 'GST HSN Summary', note: `${hsnReport.rows.length} HSN rows` },
    { key: 'monthly', title: 'Monthly Sales', note: `${monthlyReport.rows.length} days` },
    { key: 'stock', title: 'Stock Report', note: `${stockReport.length} products` },
    { key: 'top', title: 'Top Products', note: `${topProducts.rows.length} products` },
    { key: 'tax', title: 'Tax Summary', note: `${taxSummary.rows.length} GST slabs` },
    { key: 'gstr1', title: 'GSTR-1 / GST Returns', note: `${(gstr1Report.b2b?.length || 0) + (gstr1Report.b2cl?.length || 0) + (gstr1Report.b2c?.length || 0)} rows` },
    { key: 'handover', title: 'Counter Handover', note: `${counterHandoverReport.totals?.sheets || 0} sheets` },
    { key: 'exchange', title: 'Exchange Bills', note: `${exchangeReport.totals?.billCount || 0} bills` },
    { key: 'reprints', title: 'Reprints', note: `${reprintReport.totals?.count || 0} prints` },
    { key: 'barcodePrints', title: 'Barcode Stickers', note: `${barcodePrintReport.totals?.stickers || 0} stickers` },
    { key: 'returns', title: 'Returns', note: `${exceptionReport.returns.length} returns` },
    { key: 'cancelled', title: 'Cancelled Bills', note: `${exceptionReport.cancelled.length} bills` }
  ];

  const metricCards = [
    ['Bills', dailyReport.totals.billCount || 0, 'Selected range'],
    ['Taxable', formatCompactMoney(dailyReport.totals.taxable || 0), 'Sales before GST'],
    ['GST', formatCompactMoney(dailyReport.totals.gst || 0), 'Collected tax'],
    ['Exchange Bills', dailyReport.totals.exchangeBillCount || 0, 'Exchange transactions'],
    ['Exchange Sales', formatCompactMoney(dailyReport.totals.exchangeSaleTotal || 0), 'Before exchange less'],
    ['Total Sales', formatCompactMoney(dailyReport.totals.total || 0), 'Grand total']
  ];

  function exportRows(name, rows) {
    const { from, to } = getOrderedRange(fromDate, toDate);
    exportWorkbook(reportFileName(name, from, to), [{ name, rows }]);
  }

  function exportDailyExcel() {
    exportRows('daily_sales', dailyReport.rows.map((row) => ({
      'Invoice No': row.invoice_no,
      Date: row.bill_date || '',
      Time: row.bill_time || '',
      Customer: row.customer_name || 'Walk-in Customer',
      Items: Number(row.item_count || 0),
      Taxable: Number(row.sub_total || 0),
      GST: Number(row.gst_total || 0),
      'Sale Total': Number(row.sale_total || 0),
      'Exchange Less': Number(row.exchange_total || 0),
      'Net Total': Number(row.grand_total || 0),
      Mode: row.payment_mode || '',
      Counter: row.billing_counter || ''
    })));
  }

  function exportHsnExcel() {
    exportRows('gst_hsn_summary', hsnReport.rows.map((row) => ({
      HSN: row.hsn_code || '-',
      'GST %': Number(row.gst_percent || 0),
      Qty: Number(row.quantity || 0),
      Gross: Number(row.gross_total || 0),
      CGST: Number(row.cgst || 0),
      SGST: Number(row.sgst || 0),
      IGST: Number(row.igst || 0)
    })));
  }

  function exportMonthlyExcel() {
    exportRows('monthly_sales', monthlyReport.rows.map((row) => ({
      Date: row.sale_date ? new Date(row.sale_date).toLocaleDateString() : '-',
      Bills: Number(row.bill_count || 0),
      Taxable: Number(row.taxable || 0),
      GST: Number(row.gst || 0),
      Total: Number(row.total || 0)
    })));
  }

  function exportStockExcel() {
    exportRows('stock_report', stockReport.map((row) => ({
      Barcode: row.barcode,
      'Product Code': row.product_code,
      Product: row.product_name,
      HSN: row.hsn_code,
      'GST %': Number(row.gst_percent || 0),
      Purchase: Number(row.purchase_price || 0),
      Sale: Number(row.sale_price || 0),
      Stock: Number(row.stock_qty || 0),
      'Min Stock': Number(row.min_stock_alert || 0),
      Value: Number(row.stock_value || 0)
    })));
  }

  function exportTopProductsExcel() {
    exportRows('top_products', topProducts.rows.map((row) => ({
      Barcode: row.barcode,
      Product: row.product_name,
      Qty: Number(row.quantity || 0),
      Total: Number(row.total || 0)
    })));
  }

  function exportBarcodePrintsExcel() {
    exportRows('barcode_sticker_prints', (barcodePrintReport.rows || []).map((row) => ({
      Date: row.created_at,
      Barcode: row.barcode,
      Product: row.product_name,
      MRP: Number(row.mrp || 0),
      Price: Number(row.sale_price || 0),
      'Pkd Date': row.pkd_date || '',
      Qty: row.qty || '',
      Unit: row.unit || '',
      Size: row.sticker_size || row.template_name,
      Printer: row.printer_name || '',
      Stickers: Number(row.sticker_count || 0),
      User: row.created_by || ''
    })));
  }

  function exportReprintsExcel() {
    exportRows('bill_reprints', (reprintReport.rows || []).map((row) => ({
      Date: row.reprint_date || '',
      Time: row.reprint_time || '',
      'Invoice No': row.invoice_no || '',
      Format: row.print_mode || 'Thermal',
      Customer: row.customer_name || 'Walk-in Customer',
      Total: Number(row.grand_total || 0),
      Payment: row.payment_mode || '',
      Counter: row.billing_counter || '',
      'Reprinted By': row.reprinted_by || '',
      'Invoice Date': row.invoice_created_at || '',
      'Invoice Reprint Count': Number(row.reprint_count || 0)
    })));
  }

  function exportTaxExcel() {
    exportRows('tax_summary', taxSummary.rows.map((row) => ({
      'GST %': Number(row.gst_percent || 0),
      Gross: Number(row.gross_total || 0),
      CGST: Number(row.cgst || 0),
      SGST: Number(row.sgst || 0),
      IGST: Number(row.igst || 0),
      Tax: Number(row.cgst || 0) + Number(row.sgst || 0) + Number(row.igst || 0)
    })));
  }

  function exportGstr1Excel() {
    const { from, to } = getOrderedRange(fromDate, toDate);
    exportWorkbook(reportFileName('gstr1_gst_returns', from, to), [
      {
        name: '4A B2B',
        rows: (gstr1Report.b2b || []).map((row) => ({
          'GSTIN/UIN of Recipient': row.customer_gstin || '',
          'Receiver Name': row.customer_name || '',
          'Invoice No': row.invoice_no,
          'Invoice Date': row.invoice_date,
          'Invoice Value': Number(row.invoice_value || 0),
          'Place Of Supply': row.customer_gstin ? `${String(row.customer_gstin).slice(0, 2)}-State` : '36-Telangana',
          'Reverse Charge': 'N',
          'Invoice Type': 'Regular',
          Rate: Number(row.gst_percent || 0),
          'Taxable Value': Number(row.taxable_value || 0),
          CGST: Number(row.cgst || 0),
          SGST: Number(row.sgst || 0),
          IGST: Number(row.igst || 0)
        }))
      },
      {
        name: '5A B2CL',
        rows: (gstr1Report.b2cl || []).map((row) => ({
          'Invoice No': row.invoice_no,
          'Invoice Date': row.invoice_date,
          'Invoice Value': Number(row.invoice_value || 0),
          'Place Of Supply': 'Interstate',
          Rate: Number(row.gst_percent || 0),
          'Taxable Value': Number(row.taxable_value || 0),
          IGST: Number(row.igst || 0),
          Cess: 0
        }))
      },
      {
        name: '7 B2CS',
        rows: (gstr1Report.b2c || []).map((row) => ({
          Type: row.supply_type,
          'Place Of Supply': row.supply_type === 'B2CS-LOCAL' ? '36-Telangana' : 'Interstate',
          Rate: Number(row.gst_percent || 0),
          'Taxable Value': Number(row.taxable_value || 0),
          CGST: Number(row.cgst || 0),
          SGST: Number(row.sgst || 0),
          IGST: Number(row.igst || 0),
          Cess: 0,
          Bills: Number(row.bill_count || 0)
        }))
      },
      {
        name: '12 HSN B2B',
        rows: (gstr1Report.hsnB2b || []).map((row) => ({
          'HSN Code': row.hsn_code || '-',
          Description: '',
          UQC: 'NOS',
          'Total Quantity': Number(row.quantity || 0),
          'Total Value': Number(row.total_value || 0),
          Rate: Number(row.gst_percent || 0),
          'Taxable Value': Number(row.taxable_value || 0),
          CGST: Number(row.cgst || 0),
          SGST: Number(row.sgst || 0),
          IGST: Number(row.igst || 0),
          Cess: 0
        }))
      },
      {
        name: '12 HSN B2C',
        rows: (gstr1Report.hsnB2c || []).map((row) => ({
          'HSN Code': row.hsn_code || '-',
          Description: '',
          UQC: 'NOS',
          'Total Quantity': Number(row.quantity || 0),
          'Total Value': Number(row.total_value || 0),
          Rate: Number(row.gst_percent || 0),
          'Taxable Value': Number(row.taxable_value || 0),
          CGST: Number(row.cgst || 0),
          SGST: Number(row.sgst || 0),
          IGST: Number(row.igst || 0),
          Cess: 0
        }))
      },
      {
        name: '8 Nil Exempt',
        rows: (gstr1Report.nilExempt || []).map((row) => ({
          'Description': row.supply_type,
          'Nil Rated Supplies': Number(row.nil_rated_value || 0),
          'Exempted Other than Nil': 0,
          'Non GST Supplies': 0
        }))
      },
      {
        name: '13 Documents',
        rows: [{
          'Nature of Document': 'Invoices for outward supply',
          SrNoFrom: gstr1Report.documents?.from_invoice || '',
          SrNoTo: gstr1Report.documents?.to_invoice || '',
          'Total Number': Number(gstr1Report.documents?.issued_count || 0),
          Cancelled: Number(gstr1Report.documents?.cancelled_count || 0),
          NetIssued: Number(gstr1Report.documents?.netIssued || 0),
          'From Invoice': gstr1Report.documents?.from_invoice || '',
          'To Invoice': gstr1Report.documents?.to_invoice || '',
        }]
      }
    ]);
  }

  function exportCounterHandoverExcel() {
    exportRows('counter_handover', (counterHandoverReport.rows || []).map((row) => ({
      Date: row.closing_date,
      Counter: row.counter_no,
      Sheet: row.sheet_no,
      'Opening Cash': Number(row.opening_cash || 0),
      'Counter Sale': Number(row.counter_sales || 0),
      Cash: Number(row.cash_sales || 0),
      UPI: Number(row.upi_sales || 0),
      Card: Number(row.card_sales || 0),
      DR: Number(row.dr_total || 0),
      CR: Number(row.cr_total || 0),
      'Cash Notes Balance': Number(row.cash_balance || 0),
      Difference: Number(row.variance_amount || 0),
      'Handed Over By': row.handed_over_by || '',
      'Checked By': row.taken_over_by || ''
    })));
  }

  function exportExchangeExcel() {
    exportRows('exchange_bills', (exchangeReport.rows || []).map((row) => ({
      'Invoice No': row.invoice_no,
      Date: row.bill_date || '',
      Time: row.bill_time || '',
      Customer: row.customer_name || '',
      Phone: row.customer_phone || '',
      Counter: row.billing_counter || '',
      Payment: row.payment_mode || '',
      'Sale Total': Number(row.sale_total || 0),
      'Exchange Less': Number(row.exchange_total || 0),
      'Net Bill': Number(row.grand_total || 0),
      'Cash Received': Number(row.cash_received || 0),
      Change: Number(row.change_returned || 0),
      'Sale Items': Number(row.item_count || 0),
      'Exchange Items': Number(row.exchange_item_count || 0),
      'Exchange Products': (row.exchange_items || []).map((item) => `${item.barcode || ''} ${item.product_name || ''} x ${item.quantity || 0}`).join('; ')
    })));
  }

  function exportReturnsExcel() {
    exportRows('returns', exceptionReport.returns.map((row) => ({
      'Return No': row.return_no,
      'Invoice No': row.invoice_no,
      Reason: row.reason,
      Mode: row.refund_mode,
      Total: Number(row.refund_total || 0),
      By: row.created_by,
      Date: row.created_at
    })));
  }

  function exportCancelledExcel() {
    exportRows('cancelled_bills', exceptionReport.cancelled.map((row) => ({
      'Invoice No': row.invoice_no,
      Customer: row.customer_name,
      Total: Number(row.grand_total || 0),
      Reason: row.cancel_reason,
      By: row.cancelled_by,
      Date: row.cancelled_at
    })));
  }

  function renderSelectedReport() {
    switch (activeReport) {
      case 'hsn':
        return (
          <section className="panel">
            <ReportHeader title="GST HSN-wise Summary" onExcel={exportHsnExcel} onPdf={exportPdf} />
            <div className="panel-body">
              <table className="history-table">
                <thead><tr><th>HSN</th><th>GST %</th><th>Qty</th><th>Gross</th><th>CGST</th><th>SGST</th><th>IGST</th></tr></thead>
                <tbody>
                  {hsnReport.rows.length === 0 ? <tr><td colSpan="7">No GST data for selected date range.</td></tr> : hsnReport.rows.map((row) => (
                    <tr key={`${row.hsn_code}-${row.gst_percent}`}><td>{row.hsn_code || '-'}</td><td>{Number(row.gst_percent || 0)}%</td><td>{Number(row.quantity || 0)}</td><td>{formatMoney(row.gross_total)}</td><td>{formatMoney(row.cgst)}</td><td>{formatMoney(row.sgst)}</td><td>{formatMoney(row.igst)}</td></tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        );
      case 'monthly':
        return (
          <section className="panel">
            <ReportHeader title="Monthly Sales" onExcel={exportMonthlyExcel} onPdf={exportPdf} />
            <div className="panel-body">
              <table className="history-table">
                <thead><tr><th>Date</th><th>Bills</th><th>Taxable</th><th>GST</th><th>Total</th></tr></thead>
                <tbody>
                  {monthlyReport.rows.length === 0 ? <tr><td colSpan="5">No monthly sales data.</td></tr> : monthlyReport.rows.map((row) => (
                    <tr key={row.sale_date}><td>{row.sale_date ? new Date(row.sale_date).toLocaleDateString() : '-'}</td><td>{row.bill_count}</td><td>{formatMoney(row.taxable)}</td><td>{formatMoney(row.gst)}</td><td><strong>{formatMoney(row.total)}</strong></td></tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        );
      case 'stock':
        return (
          <section className="panel">
            <ReportHeader title="Stock Report" onExcel={exportStockExcel} onPdf={exportPdf} />
            <div className="panel-body">
              <table className="history-table">
                <thead><tr><th>Barcode</th><th>Product</th><th>HSN</th><th>GST%</th><th>Purchase</th><th>Sale</th><th>Stock</th><th>Value</th></tr></thead>
                <tbody>
                  {stockReport.length === 0 ? <tr><td colSpan="8">No stock data.</td></tr> : stockReport.map((row) => (
                    <tr key={row.barcode}><td className="mono">{row.barcode}</td><td>{row.product_name}</td><td>{row.hsn_code}</td><td>{Number(row.gst_percent || 0)}%</td><td>{formatMoney(row.purchase_price)}</td><td>{formatMoney(row.sale_price)}</td><td>{Number(row.stock_qty || 0)}</td><td>{formatMoney(row.stock_value)}</td></tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        );
      case 'top':
        return (
          <section className="panel">
            <ReportHeader title="Top Products" onExcel={exportTopProductsExcel} onPdf={exportPdf} />
            <div className="panel-body">
              <table className="history-table">
                <thead><tr><th>Barcode</th><th>Product</th><th>Qty</th><th>Total</th></tr></thead>
                <tbody>
                  {topProducts.rows.length === 0 ? <tr><td colSpan="4">No product movement data.</td></tr> : topProducts.rows.map((row) => (
                    <tr key={row.barcode}><td className="mono">{row.barcode}</td><td>{row.product_name}</td><td>{Number(row.quantity || 0)}</td><td>{formatMoney(row.total)}</td></tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        );
      case 'tax':
        return (
          <section className="panel">
            <ReportHeader title="Tax Summary" onExcel={exportTaxExcel} onPdf={exportPdf} />
            <div className="panel-body">
              <table className="history-table">
                <thead><tr><th>GST %</th><th>Gross</th><th>CGST</th><th>SGST</th><th>IGST</th><th>Total Tax</th></tr></thead>
                <tbody>
                  {taxSummary.rows.length === 0 ? <tr><td colSpan="6">No tax data.</td></tr> : taxSummary.rows.map((row) => (
                    <tr key={row.gst_percent}><td>{Number(row.gst_percent || 0)}%</td><td>{formatMoney(row.gross_total)}</td><td>{formatMoney(row.cgst)}</td><td>{formatMoney(row.sgst)}</td><td>{formatMoney(row.igst)}</td><td>{formatMoney(Number(row.cgst || 0) + Number(row.sgst || 0) + Number(row.igst || 0))}</td></tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        );
      case 'gstr1':
        return (
          <section className="panel">
            <ReportHeader title="GSTR-1 / GST Returns" onExcel={exportGstr1Excel} onPdf={exportPdf} />
            <div className="panel-body form-stack">
              <div className="alert-box">
                GST filing review format: verify GSTIN, place of supply, HSN/UQC and nil-rated values before uploading to GST portal/offline utility.
              </div>
              <section>
                <h3 className="panel-title">4A, 4B, 4C, 6B, 6C - B2B Invoices</h3>
                <table className="history-table">
                  <thead><tr><th>GSTIN/UIN</th><th>Receiver</th><th>Invoice No</th><th>Date</th><th>Place</th><th>Rate</th><th>Taxable</th><th>CGST</th><th>SGST</th><th>IGST</th><th>Invoice Value</th></tr></thead>
                  <tbody>
                    {(gstr1Report.b2b || []).length === 0 ? <tr><td colSpan="11">No B2B invoices found.</td></tr> : gstr1Report.b2b.map((row, index) => (
                      <tr key={`${row.invoice_no}-${row.gst_percent}-${index}`}><td>{row.customer_gstin || '-'}</td><td>{row.customer_name || '-'}</td><td>{row.invoice_no}</td><td>{row.invoice_date}</td><td>{row.customer_gstin ? `${String(row.customer_gstin).slice(0, 2)}-State` : '36-Telangana'}</td><td>{Number(row.gst_percent || 0)}%</td><td>{formatMoney(row.taxable_value)}</td><td>{formatMoney(row.cgst)}</td><td>{formatMoney(row.sgst)}</td><td>{formatMoney(row.igst)}</td><td>{formatMoney(row.invoice_value)}</td></tr>
                    ))}
                  </tbody>
                </table>
              </section>

              <section>
                <h3 className="panel-title">5A, 5B - B2C Large Invoices</h3>
                <table className="history-table">
                  <thead><tr><th>Invoice No</th><th>Date</th><th>Customer</th><th>Place</th><th>Rate</th><th>Taxable</th><th>IGST</th><th>Invoice Value</th></tr></thead>
                  <tbody>
                    {(gstr1Report.b2cl || []).length === 0 ? <tr><td colSpan="8">No B2C large interstate invoices found.</td></tr> : gstr1Report.b2cl.map((row, index) => (
                      <tr key={`${row.invoice_no}-${row.gst_percent}-${index}`}><td>{row.invoice_no}</td><td>{row.invoice_date}</td><td>{row.customer_name || '-'}</td><td>Interstate</td><td>{Number(row.gst_percent || 0)}%</td><td>{formatMoney(row.taxable_value)}</td><td>{formatMoney(row.igst)}</td><td>{formatMoney(row.invoice_value)}</td></tr>
                    ))}
                  </tbody>
                </table>
              </section>

              <section>
                <h3 className="panel-title">7 - B2C Others Summary</h3>
                <table className="history-table">
                  <thead><tr><th>Type</th><th>Place</th><th>Rate</th><th>Bills</th><th>Taxable</th><th>CGST</th><th>SGST</th><th>IGST</th><th>Total</th></tr></thead>
                  <tbody>
                    {(gstr1Report.b2c || []).length === 0 ? <tr><td colSpan="9">No B2C sales found.</td></tr> : gstr1Report.b2c.map((row) => (
                      <tr key={`${row.supply_type}-${row.gst_percent}`}><td>{row.supply_type}</td><td>{row.supply_type === 'B2CS-LOCAL' ? '36-Telangana' : 'Interstate'}</td><td>{Number(row.gst_percent || 0)}%</td><td>{Number(row.bill_count || 0)}</td><td>{formatMoney(row.taxable_value)}</td><td>{formatMoney(row.cgst)}</td><td>{formatMoney(row.sgst)}</td><td>{formatMoney(row.igst)}</td><td>{formatMoney(row.gross_value)}</td></tr>
                    ))}
                  </tbody>
                </table>
              </section>

              <section>
                <h3 className="panel-title">12 - HSN Summary B2B</h3>
                <table className="history-table">
                  <thead><tr><th>HSN</th><th>UQC</th><th>Rate</th><th>Qty</th><th>Taxable</th><th>CGST</th><th>SGST</th><th>IGST</th><th>Total</th></tr></thead>
                  <tbody>
                    {(gstr1Report.hsnB2b || []).length === 0 ? <tr><td colSpan="9">No B2B HSN data found.</td></tr> : gstr1Report.hsnB2b.map((row) => (
                      <tr key={`${row.hsn_code}-${row.gst_percent}`}><td>{row.hsn_code || '-'}</td><td>NOS</td><td>{Number(row.gst_percent || 0)}%</td><td>{Number(row.quantity || 0)}</td><td>{formatMoney(row.taxable_value)}</td><td>{formatMoney(row.cgst)}</td><td>{formatMoney(row.sgst)}</td><td>{formatMoney(row.igst)}</td><td>{formatMoney(row.total_value)}</td></tr>
                    ))}
                  </tbody>
                </table>
              </section>

              <section>
                <h3 className="panel-title">12 - HSN Summary B2C</h3>
                <table className="history-table">
                  <thead><tr><th>HSN</th><th>UQC</th><th>Rate</th><th>Qty</th><th>Taxable</th><th>CGST</th><th>SGST</th><th>IGST</th><th>Total</th></tr></thead>
                  <tbody>
                    {(gstr1Report.hsnB2c || []).length === 0 ? <tr><td colSpan="9">No B2C HSN data found.</td></tr> : gstr1Report.hsnB2c.map((row) => (
                      <tr key={`${row.hsn_code}-${row.gst_percent}`}><td>{row.hsn_code || '-'}</td><td>NOS</td><td>{Number(row.gst_percent || 0)}%</td><td>{Number(row.quantity || 0)}</td><td>{formatMoney(row.taxable_value)}</td><td>{formatMoney(row.cgst)}</td><td>{formatMoney(row.sgst)}</td><td>{formatMoney(row.igst)}</td><td>{formatMoney(row.total_value)}</td></tr>
                    ))}
                  </tbody>
                </table>
              </section>

              <section>
                <h3 className="panel-title">8 - Nil Rated / Exempt / Non GST</h3>
                <table className="history-table">
                  <thead><tr><th>Description</th><th>Nil Rated</th><th>Exempted</th><th>Non GST</th></tr></thead>
                  <tbody>
                    {(gstr1Report.nilExempt || []).length === 0 ? <tr><td colSpan="4">No nil-rated supplies found.</td></tr> : gstr1Report.nilExempt.map((row) => (
                      <tr key={row.supply_type}><td>{row.supply_type}</td><td>{formatMoney(row.nil_rated_value)}</td><td>{formatMoney(0)}</td><td>{formatMoney(0)}</td></tr>
                    ))}
                  </tbody>
                </table>
              </section>

              <section className="report-summary-strip">
                <span>Invoices: <strong>{Number(gstr1Report.documents?.issued_count || 0)}</strong></span>
                <span>Cancelled: <strong>{Number(gstr1Report.documents?.cancelled_count || 0)}</strong></span>
                <span>From: <strong>{gstr1Report.documents?.from_invoice || '-'}</strong></span>
                <span>To: <strong>{gstr1Report.documents?.to_invoice || '-'}</strong></span>
                <span>Taxable: <strong>{formatMoney(gstr1Report.totals?.taxable || 0)}</strong></span>
                <span>Total Tax: <strong>{formatMoney(Number(gstr1Report.totals?.cgst || 0) + Number(gstr1Report.totals?.sgst || 0) + Number(gstr1Report.totals?.igst || 0))}</strong></span>
                <span>Total: <strong>{formatMoney(gstr1Report.totals?.total || 0)}</strong></span>
              </section>
            </div>
          </section>
        );
      case 'returns':
        return (
          <section className="panel">
            <ReportHeader title="Returns" onExcel={exportReturnsExcel} onPdf={exportPdf} />
            <div className="panel-body">
              <table className="history-table">
                <thead><tr><th>Return No</th><th>Invoice No</th><th>Reason</th><th>Mode</th><th>Total</th><th>By</th><th>Date</th></tr></thead>
                <tbody>
                  {exceptionReport.returns.length === 0 ? <tr><td colSpan="7">No returns found.</td></tr> : exceptionReport.returns.map((row) => (
                    <tr key={row.return_no}><td>{row.return_no}</td><td>{row.invoice_no}</td><td>{row.reason}</td><td>{row.refund_mode}</td><td>{formatMoney(row.refund_total)}</td><td>{row.created_by}</td><td>{row.created_at}</td></tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        );
      case 'exchange':
        return (
          <section className="panel">
            <ReportHeader title="Exchange Bills Report" onExcel={exportExchangeExcel} onPdf={exportPdf} />
            <div className="panel-body form-stack">
              <section className="report-summary-strip">
                <span>Bills: <strong>{Number(exchangeReport.totals?.billCount || 0)}</strong></span>
                <span>Sale Total: <strong>{formatMoney(exchangeReport.totals?.saleTotal || 0)}</strong></span>
                <span>Exchange Less: <strong>{formatMoney(exchangeReport.totals?.exchangeTotal || 0)}</strong></span>
                <span>Net Bills: <strong>{formatMoney(exchangeReport.totals?.netTotal || 0)}</strong></span>
                <span>Exchange Items: <strong>{Number(exchangeReport.totals?.exchangeItemCount || 0)}</strong></span>
              </section>
              <table className="history-table">
                <thead>
                  <tr><th>Invoice No</th><th>Date</th><th>Customer</th><th>Phone</th><th>Counter</th><th>Payment</th><th>Sale Total</th><th>Exchange Less</th><th>Net Bill</th><th>Exchange Products</th></tr>
                </thead>
                <tbody>
                  {(exchangeReport.rows || []).length === 0 ? <tr><td colSpan="10">No exchange bills found.</td></tr> : exchangeReport.rows.map((row) => (
                    <tr key={row.invoice_no}>
                      <td className="mono">{row.invoice_no}</td>
                      <td>{row.bill_date || '-'} {row.bill_time || ''}</td>
                      <td>{row.customer_name || '-'}</td>
                      <td>{row.customer_phone || '-'}</td>
                      <td>{row.billing_counter || '-'}</td>
                      <td>{row.payment_mode || '-'}</td>
                      <td>{formatMoney(row.sale_total)}</td>
                      <td><strong>{formatMoney(row.exchange_total)}</strong></td>
                      <td><strong>{formatMoney(row.grand_total)}</strong></td>
                      <td>
                        {(row.exchange_items || []).length === 0 ? '-' : row.exchange_items.map((item, index) => (
                          <div key={`${row.invoice_no}-${item.barcode || index}`}>
                            <span className="mono">{item.barcode || '-'}</span> {item.product_name || '-'} x {Number(item.quantity || 0)}
                          </div>
                        ))}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        );
      case 'handover':
        return (
          <section className="panel">
            <ReportHeader title="Counter Handover Report" onExcel={exportCounterHandoverExcel} onPdf={exportPdf} />
            <div className="panel-body form-stack">
              <section className="report-summary-strip">
                <span>Sheets: <strong>{Number(counterHandoverReport.totals?.sheets || 0)}</strong></span>
                <span>Counter Sales: <strong>{formatMoney(counterHandoverReport.totals?.counterSales || 0)}</strong></span>
                <span>DR: <strong>{formatMoney(counterHandoverReport.totals?.dr || 0)}</strong></span>
                <span>CR: <strong>{formatMoney(counterHandoverReport.totals?.cr || 0)}</strong></span>
                <span>Cash Notes Balance: <strong>{formatMoney(counterHandoverReport.totals?.cashBalance || 0)}</strong></span>
                <span>Difference: <strong>{formatMoney(counterHandoverReport.totals?.difference || 0)}</strong></span>
              </section>
              <table className="history-table">
                <thead><tr><th>Date</th><th>Counter</th><th>Sheet</th><th>Opening</th><th>Sale</th><th>Cash</th><th>UPI</th><th>Card</th><th>DR</th><th>CR</th><th>Cash Notes</th><th>Difference</th><th>Handover</th></tr></thead>
                <tbody>
                  {(counterHandoverReport.rows || []).length === 0 ? <tr><td colSpan="13">No counter handover sheets found.</td></tr> : counterHandoverReport.rows.map((row) => (
                    <tr key={row.sheet_no}>
                      <td>{row.closing_date}</td>
                      <td>Counter {row.counter_no}</td>
                      <td className="mono">{row.sheet_no}</td>
                      <td>{formatMoney(row.opening_cash)}</td>
                      <td>{formatMoney(row.counter_sales)}</td>
                      <td>{formatMoney(row.cash_sales)}</td>
                      <td>{formatMoney(row.upi_sales)}</td>
                      <td>{formatMoney(row.card_sales)}</td>
                      <td>{formatMoney(row.dr_total)}</td>
                      <td>{formatMoney(row.cr_total)}</td>
                      <td><strong>{formatMoney(row.cash_balance)}</strong></td>
                      <td className={Math.abs(Number(row.variance_amount || 0)) > 0.01 ? 'stock-low' : ''}>{formatMoney(row.variance_amount)}</td>
                      <td>{row.handed_over_by || '-'} to {row.taken_over_by || '-'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        );
      case 'barcodePrints':
        return (
          <section className="panel">
            <ReportHeader title="Barcode Sticker Print Report" onExcel={exportBarcodePrintsExcel} onPdf={exportPdf} />
            <div className="panel-body form-stack">
              <section className="report-summary-strip">
                <span>Print Runs: <strong>{Number(barcodePrintReport.totals?.prints || 0)}</strong></span>
                <span>Total Stickers: <strong>{Number(barcodePrintReport.totals?.stickers || 0)}</strong></span>
              </section>
              <table className="history-table">
                <thead>
                  <tr>
                    <th>Date / Time</th>
                    <th>Barcode</th>
                    <th>Product</th>
                    <th>MRP</th>
                    <th>Price</th>
                    <th>Pkd Date</th>
                    <th>Qty</th>
                    <th>Size</th>
                    <th>Printer</th>
                    <th>Stickers</th>
                    <th>File</th>
                  </tr>
                </thead>
                <tbody>
                  {(barcodePrintReport.rows || []).length === 0 ? (
                    <tr><td colSpan="11">No barcode sticker print history found.</td></tr>
                  ) : barcodePrintReport.rows.map((row) => (
                    <tr key={row.id}>
                      <td>{row.created_at || '-'}</td>
                      <td className="mono">{row.barcode || '-'}</td>
                      <td>{row.product_name || '-'}</td>
                      <td>{formatMoney(row.mrp)}</td>
                      <td>{formatMoney(row.sale_price)}</td>
                      <td>{row.pkd_date || '-'}</td>
                      <td>{row.qty || '-'} {row.unit || ''}</td>
                      <td>{row.sticker_size || row.template_name || '-'}</td>
                      <td>{row.printer_name || '-'}</td>
                      <td><strong>{Number(row.sticker_count || 0)}</strong></td>
                      <td>{row.output_name || '-'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        );
      case 'reprints':
        return (
          <section className="panel">
            <ReportHeader title="Bill Reprints Report" onExcel={exportReprintsExcel} onPdf={exportPdf} />
            <div className="panel-body form-stack">
              <section className="report-summary-strip">
                <span>Total Reprints: <strong>{Number(reprintReport.totals?.count || 0)}</strong></span>
                <span>Thermal: <strong>{Number(reprintReport.totals?.thermal || 0)}</strong></span>
                <span>A4: <strong>{Number(reprintReport.totals?.a4 || 0)}</strong></span>
              </section>
              <table className="history-table">
                <thead>
                  <tr>
                    <th>Date</th>
                    <th>Time</th>
                    <th>Invoice No</th>
                    <th>Format</th>
                    <th>Customer</th>
                    <th>Total</th>
                    <th>Payment</th>
                    <th>Counter</th>
                    <th>Reprinted By</th>
                  </tr>
                </thead>
                <tbody>
                  {(reprintReport.rows || []).length === 0 ? (
                    <tr><td colSpan="9">No bill reprints found for selected date range.</td></tr>
                  ) : reprintReport.rows.map((row) => (
                    <tr key={row.id}>
                      <td>{row.reprint_date || '-'}</td>
                      <td>{row.reprint_time || '-'}</td>
                      <td className="mono">{row.invoice_no || '-'}</td>
                      <td><strong>{row.print_mode || 'Thermal'}</strong></td>
                      <td>{row.customer_name || 'Walk-in Customer'}</td>
                      <td>{formatMoney(row.grand_total)}</td>
                      <td>{row.payment_mode || '-'}</td>
                      <td>{row.billing_counter || '-'}</td>
                      <td>{row.reprinted_by || '-'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        );
      case 'cancelled':
        return (
          <section className="panel">
            <ReportHeader title="Cancelled Bills" onExcel={exportCancelledExcel} onPdf={exportPdf} />
            <div className="panel-body">
              <table className="history-table">
                <thead><tr><th>Invoice No</th><th>Customer</th><th>Total</th><th>Reason</th><th>By</th><th>Date</th></tr></thead>
                <tbody>
                  {exceptionReport.cancelled.length === 0 ? <tr><td colSpan="6">No cancelled bills found.</td></tr> : exceptionReport.cancelled.map((row) => (
                    <tr key={row.invoice_no}><td>{row.invoice_no}</td><td>{row.customer_name || '-'}</td><td>{formatMoney(row.grand_total)}</td><td>{row.cancel_reason || '-'}</td><td>{row.cancelled_by || '-'}</td><td>{row.cancelled_at || '-'}</td></tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        );
      default:
        return (
          <section className="panel">
            <ReportHeader title="Daily Sales Report" onExcel={exportDailyExcel} onPdf={exportPdf} />
            <div className="panel-body form-stack">
              <section className="report-summary-strip">
                <span>Bills: <strong>{Number(dailyReport.totals.billCount || 0)}</strong></span>
                <span>Sale Total: <strong>{formatMoney(dailyReport.totals.saleTotal || 0)}</strong></span>
                <span>Exchange Bills: <strong>{Number(dailyReport.totals.exchangeBillCount || 0)}</strong></span>
                <span>Exchange Sale: <strong>{formatMoney(dailyReport.totals.exchangeSaleTotal || 0)}</strong></span>
                <span>Exchange Less: <strong>{formatMoney(dailyReport.totals.exchangeLess || 0)}</strong></span>
                <span>Exchange Net: <strong>{formatMoney(dailyReport.totals.exchangeNetTotal || 0)}</strong></span>
                <span>Net Sales: <strong>{formatMoney(dailyReport.totals.total || 0)}</strong></span>
              </section>
              <table className="history-table">
                <thead><tr><th>Invoice No</th><th>Date</th><th>Time</th><th>Customer</th><th>Items</th><th>Taxable</th><th>GST</th><th>Sale Total</th><th>Exchange Less</th><th>Net Total</th><th>Mode</th><th>Counter</th></tr></thead>
                <tbody>
                  {dailyReport.rows.length === 0 ? <tr><td colSpan="12">No invoices found for selected date range.</td></tr> : dailyReport.rows.map((row) => (
                    <tr key={row.invoice_no}><td className="mono">{row.invoice_no}</td><td>{row.bill_date || '-'}</td><td>{row.bill_time}</td><td>{row.customer_name || 'Walk-in Customer'}</td><td>{row.item_count}</td><td>{formatMoney(row.sub_total)}</td><td>{formatMoney(row.gst_total)}</td><td>{formatMoney(row.sale_total || row.grand_total)}</td><td>{Number(row.exchange_total || 0) > 0 ? <strong>{formatMoney(row.exchange_total)}</strong> : formatMoney(0)}</td><td><strong>{formatMoney(row.grand_total)}</strong></td><td>{row.payment_mode}</td><td>{row.billing_counter}</td></tr>
                  ))}
                </tbody>
                <tfoot><tr><th>Total</th><th></th><th></th><th></th><th>{dailyReport.totals.itemCount || 0}</th><th>{formatMoney(dailyReport.totals.taxable || 0)}</th><th>{formatMoney(dailyReport.totals.gst || 0)}</th><th>{formatMoney(dailyReport.totals.saleTotal || 0)}</th><th>{formatMoney(dailyReport.totals.exchangeLess || 0)}</th><th>{formatMoney(dailyReport.totals.total || 0)}</th><th></th><th></th></tr></tfoot>
              </table>
              <div className="report-action-row">
                <button className="primary-button" type="button" onClick={printReport}>Print Report</button>
                <button className="secondary-button" type="button" onClick={exportDailyExcel}>Export Excel</button>
                <button className="secondary-button" type="button" onClick={exportPdf}>Export PDF</button>
                <button className="secondary-button" type="button" onClick={() => {
                  const { from, to } = getOrderedRange(fromDate, toDate);
                  exportDailySalesReport({ from, to, counter });
                }}>Export CSV</button>
              </div>
            </div>
          </section>
        );
    }
  }

  return (
    <div className="form-stack reports-view">
      {errorMessage && <div className="alert-box">{errorMessage}</div>}

      <section className="dashboard-grid reports-metric-grid">
        {metricCards.map(([label, value, note]) => (
          <div className="metric-card" key={label}>
            <div className="muted">{label}</div>
            <span className="metric-value">{value}</span>
            <div className="muted">{note}</div>
          </div>
        ))}
      </section>

      <section className="panel">
        <div className="panel-header green"><h2 className="panel-title">Reports</h2></div>
        <div className="panel-body form-stack">
          <form className="report-filter-row" onSubmit={handleReportFilterSubmit}>
            <label className="date-range-field">
              <span className="field-label">From Date</span>
              <input className="field report-date-input" type="date" value={fromDate} onChange={(event) => setFromDate(event.target.value)} />
            </label>
            <label className="date-range-field">
              <span className="field-label">To Date</span>
              <input className="field report-date-input" type="date" value={toDate} onChange={(event) => setToDate(event.target.value)} />
            </label>
            <select className="select" value={counter} onChange={(event) => setCounter(event.target.value)}>
              <option value="">All Counters</option>
              {counterOptions.map((option) => <option key={option} value={option}>{option}</option>)}
            </select>
            <label className="date-range-field">
              <span className="field-label">Search</span>
              <input
                className="field"
                value={reportSearch}
                onChange={(event) => setReportSearch(event.target.value)}
                placeholder="Invoice / customer / barcode / user"
              />
            </label>
            <button className="secondary-button" type="button" onClick={loadReports}>View</button>
            <button className="close-action-button" type="button" onClick={onClose}>Close</button>
          </form>

          <div className="report-selector-grid">
            {reportOptions.map((report) => (
              <button
                key={report.key}
                className={`report-select-card ${activeReport === report.key ? 'active' : ''}`}
                type="button"
                onClick={() => setActiveReport(report.key)}
              >
                <strong>{report.title}</strong>
                <span>{report.note}</span>
              </button>
            ))}
          </div>
        </div>
      </section>

      <div className="reports-print-area" onClick={(event) => {
        if (event.target.closest('.report-print-trigger')) {
          printReport();
        }
      }}>
        {renderSelectedReport()}
      </div>
    </div>
  );
}
