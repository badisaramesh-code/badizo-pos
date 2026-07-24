import React, { useDeferredValue, useEffect, useMemo, useState } from 'react';
import * as XLSX from 'xlsx';
import {
  exportDailySalesReport,
  fetchBarcodePrintLogs,
  fetchCounterHandoverReport,
  fetchDailySalesReport,
  fetchExchangeBillsReport,
  fetchExceptionReport,
  fetchGstHsnReport,
  fetchGstHsnProductDetails,
  fetchGstr1Report,
  fetchGstr2Report,
  fetchGstr3Report,
  fetchMonthlySalesReport,
  fetchProductSalesReport,
  fetchReprintReport,
  fetchStockReport,
  fetchTaxSummaryReport,
  fetchTopProductsReport,
  searchProducts
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

function currentMonthStartIso() {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), 1).toISOString().slice(0, 10);
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

const HSN_RANGE_OPTIONS = [
  { value: 'ALL', label: 'All HSN' },
  { value: '0-1000', label: '0 - 1000', min: 0, max: 1000 },
  { value: '1001-9999', label: '1001 - 9999', min: 1001, max: 9999 },
  { value: '10000-UP', label: '10000 & above', min: 10000, max: Infinity }
];

const GST_PERCENT_OPTIONS = ['ALL', '0', '3', '5', '18', '40'];

const QTY_SORT_OPTIONS = [
  { value: 'DEFAULT', label: 'Default Qty' },
  { value: 'TOP', label: 'Top Qty' },
  { value: 'LOW', label: 'Low Qty' }
];

const DEFAULT_HSN_FILTERS = {
  hsnRange: 'ALL',
  gstPercent: 'ALL',
  productSearch: '',
  qtySort: 'DEFAULT'
};

const HSN_VISIBLE_ROW_LIMIT = 500;
const HANDOVER_AUTO_ENTRY_DETAILS = new Set(['Counter Closing Cash', 'Today Sale']);
const HANDOVER_DENOMINATIONS = [2000, 500, 200, 100, 50, 20, 10, 5, 2, 1];
const TOP_PRODUCT_SORT_LABELS = {
  quantity: 'Qty',
  total: 'Total'
};

function isHandoverAutoEntry(entry) {
  return HANDOVER_AUTO_ENTRY_DETAILS.has(String(entry?.details || '').trim());
}

function getHsnNumber(value) {
  const match = String(value || '').match(/\d+/);
  return match ? Number(match[0]) : null;
}

function getReportNumber(value) {
  const number = Number(String(value ?? 0).replace(/[^0-9.-]/g, ''));
  return Number.isFinite(number) ? number : 0;
}

function ReportHeader({ title, onExcel, onPdf, onClose }) {
  return (
    <div className="panel-header green">
      <h2 className="panel-title">{title}</h2>
      <div className="report-header-actions">
        <button className="header-print-button report-print-trigger" type="button">Print Report</button>
        <button className="header-print-button" type="button" onClick={onExcel}>Export Excel</button>
        <button className="header-print-button" type="button" onClick={onPdf}>Export PDF</button>
        {onClose && <button className="close-action-button" type="button" onClick={onClose}>Close</button>}
      </div>
    </div>
  );
}

export default function ReportsView({ isActive = true, onClose }) {
  const [activeReport, setActiveReport] = useState('daily');
  const [isReportOpen, setIsReportOpen] = useState(false);
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
  const [hsnFilters, setHsnFilters] = useState(DEFAULT_HSN_FILTERS);
  const [hsnProductSearch, setHsnProductSearch] = useState('');
  const [hsnProductDetails, setHsnProductDetails] = useState({ rows: [], totals: { quantity: 0, gross: 0, cgst: 0, sgst: 0, igst: 0 } });
  const [hsnProductDetailError, setHsnProductDetailError] = useState('');
  const [hsnProductDetailLoading, setHsnProductDetailLoading] = useState(false);
  const [hsnProductSuggestions, setHsnProductSuggestions] = useState([]);
  const [isHsnProductSuggestionOpen, setIsHsnProductSuggestionOpen] = useState(false);
  const [productSalesSearch, setProductSalesSearch] = useState('');
  const [productSalesReport, setProductSalesReport] = useState({ rows: [], totals: { bills: 0, quantity: 0, gross: 0, cash: 0, upi: 0, card: 0, other: 0 } });
  const [productSalesError, setProductSalesError] = useState('');
  const [productSalesLoading, setProductSalesLoading] = useState(false);
  const [productSalesSuggestions, setProductSalesSuggestions] = useState([]);
  const [isProductSalesSuggestionOpen, setIsProductSalesSuggestionOpen] = useState(false);
  const [monthlyReport, setMonthlyReport] = useState({ rows: [] });
  const [stockReport, setStockReport] = useState([]);
  const [topProducts, setTopProducts] = useState({ rows: [] });
  const [topProductSort, setTopProductSort] = useState({ key: 'quantity', direction: 'desc' });
  const [taxSummary, setTaxSummary] = useState({ rows: [] });
  const [gstr1Report, setGstr1Report] = useState({ b2b: [], b2cl: [], b2c: [], hsn: [], hsnB2b: [], hsnB2c: [], nilExempt: [], documents: {}, totals: {} });
  const [gstr2Report, setGstr2Report] = useState({ b2b: [], hsn: [], totals: {} });
  const [gstr3Report, setGstr3Report] = useState({ outward: [], inward: [], threeB: { outward: [], itc: [], payment: [] }, checks: {}, totals: {} });
  const [counterHandoverReport, setCounterHandoverReport] = useState({ rows: [], totals: {} });
  const [exceptionReport, setExceptionReport] = useState({ cancelled: [], returns: [] });
  const [exchangeReport, setExchangeReport] = useState({ rows: [], totals: {} });
  const [barcodePrintReport, setBarcodePrintReport] = useState({ rows: [], totals: {} });
  const [reprintReport, setReprintReport] = useState({ rows: [], totals: {} });
  const [isReportLoading, setIsReportLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');
  const deferredHsnProductSearch = useDeferredValue(hsnFilters.productSearch);

  useEffect(() => {
    if (isActive) loadReports();
  }, [isActive]);

  useEffect(() => {
    if (isActive) refreshSelectedReport(activeReport);
  }, [activeReport, isActive]);

  useEffect(() => {
    if (!isActive) setIsReportOpen(false);
  }, [isActive]);

  useEffect(() => {
    if (!isReportOpen) return undefined;
    const handleKeyDown = (event) => {
      if (event.key === 'Escape') setIsReportOpen(false);
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isReportOpen]);

  const filteredHsnRows = useMemo(() => {
    const productSearch = deferredHsnProductSearch.trim().toLowerCase();
    const selectedRange = HSN_RANGE_OPTIONS.find((option) => option.value === hsnFilters.hsnRange);
    const rows = (hsnReport.rows || []).filter((row) => {
      if (selectedRange && selectedRange.value !== 'ALL') {
        const hsnNumber = getHsnNumber(row.hsn_code);
        if (hsnNumber === null || hsnNumber < selectedRange.min || hsnNumber > selectedRange.max) {
          return false;
        }
      }

      if (hsnFilters.gstPercent !== 'ALL' && Number(row.gst_percent || 0) !== Number(hsnFilters.gstPercent)) {
        return false;
      }

      if (productSearch) {
        const productText = `${row.product_code || ''} ${row.product_name || ''}`.toLowerCase();
        if (!productText.includes(productSearch)) return false;
      }

      return true;
    });

    if (hsnFilters.qtySort === 'TOP') {
      return [...rows].sort((a, b) => Number(b.quantity || 0) - Number(a.quantity || 0));
    }

    if (hsnFilters.qtySort === 'LOW') {
      return [...rows].sort((a, b) => Number(a.quantity || 0) - Number(b.quantity || 0));
    }

    return rows;
  }, [deferredHsnProductSearch, hsnFilters.gstPercent, hsnFilters.hsnRange, hsnFilters.qtySort, hsnReport.rows]);

  const visibleHsnRows = useMemo(() => filteredHsnRows.slice(0, HSN_VISIBLE_ROW_LIMIT), [filteredHsnRows]);

  const sortedTopProductRows = useMemo(() => {
    const rows = topProducts.rows || [];
    const sortKey = topProductSort.key;
    const direction = topProductSort.direction === 'asc' ? 1 : -1;
    return [...rows].sort((a, b) => {
      const aValue = getReportNumber(a[sortKey]);
      const bValue = getReportNumber(b[sortKey]);
      if (aValue !== bValue) return (aValue - bValue) * direction;
      return String(a.product_name || '').localeCompare(String(b.product_name || ''));
    });
  }, [topProductSort.direction, topProductSort.key, topProducts.rows]);

  const gstCheckIssueCount = useMemo(() => Object.values(gstr3Report.checks || {}).reduce((total, rows) => (
    total + (Array.isArray(rows) ? rows.length : 0)
  ), 0), [gstr3Report.checks]);

  const filteredHsnTotals = useMemo(() => filteredHsnRows.reduce((totals, row) => ({
    gross: totals.gross + Number(row.gross_total || 0),
    cgst: totals.cgst + Number(row.cgst || 0),
    sgst: totals.sgst + Number(row.sgst || 0),
    igst: totals.igst + Number(row.igst || 0)
  }), { gross: 0, cgst: 0, sgst: 0, igst: 0 }), [filteredHsnRows]);

  useEffect(() => {
    if (activeReport !== 'hsn') {
      setHsnProductSuggestions([]);
      setIsHsnProductSuggestionOpen(false);
      return undefined;
    }

    const query = hsnProductSearch.trim();
    if (query.length < 3) {
      setHsnProductSuggestions([]);
      setIsHsnProductSuggestionOpen(false);
      return undefined;
    }

    let cancelled = false;
    const timer = window.setTimeout(async () => {
      try {
        const rows = await searchProducts(query);
        if (!cancelled) {
          setHsnProductSuggestions(rows.slice(0, 6));
          setIsHsnProductSuggestionOpen(rows.length > 0);
        }
      } catch (err) {
        if (!cancelled) {
          setHsnProductSuggestions([]);
          setIsHsnProductSuggestionOpen(false);
        }
      }
    }, 250);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [activeReport, hsnProductSearch]);

  useEffect(() => {
    if (activeReport !== 'productSales') {
      setProductSalesSuggestions([]);
      setIsProductSalesSuggestionOpen(false);
      return undefined;
    }

    const query = productSalesSearch.trim();
    if (query.length < 3) {
      setProductSalesSuggestions([]);
      setIsProductSalesSuggestionOpen(false);
      return undefined;
    }

    let cancelled = false;
    const timer = window.setTimeout(async () => {
      try {
        const rows = await searchProducts(query);
        if (!cancelled) {
          setProductSalesSuggestions(rows.slice(0, 6));
          setIsProductSalesSuggestionOpen(rows.length > 0);
        }
      } catch (err) {
        if (!cancelled) {
          setProductSalesSuggestions([]);
          setIsProductSalesSuggestionOpen(false);
        }
      }
    }, 250);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [activeReport, productSalesSearch]);

  async function selectHsnProduct(product) {
    const searchText = product.barcode || product.product_code || product.product_name || '';
    setHsnProductSearch(searchText);
    setHsnFilters((current) => ({ ...current, productSearch: product.product_name || product.product_code || searchText }));
    setHsnProductSuggestions([]);
    setIsHsnProductSuggestionOpen(false);
    const range = getOrderedRange(fromDate, toDate);
    setHsnProductDetailLoading(true);
    setHsnProductDetailError('');
    try {
      const data = await fetchGstHsnProductDetails({ ...range, search: searchText });
      setHsnProductDetails(data);
    } catch (err) {
      setHsnProductDetailError(err.response?.data?.error || 'Unable to load product sale details.');
    } finally {
      setHsnProductDetailLoading(false);
    }
  }

  async function handleHsnProductDetailSubmit(event) {
    event.preventDefault();
    const search = hsnProductSearch.trim();
    if (!search) {
      setHsnProductDetailError('Enter product code, barcode, or product name.');
      setHsnProductDetails({ rows: [], totals: { quantity: 0, gross: 0, cgst: 0, sgst: 0, igst: 0 } });
      return;
    }

    setHsnProductDetailLoading(true);
    setHsnProductDetailError('');
    try {
      const { from, to } = getOrderedRange(fromDate, toDate);
      const data = await fetchGstHsnProductDetails({ from, to, search });
      setHsnProductDetails({
        rows: data.rows || [],
        totals: data.totals || { quantity: 0, gross: 0, cgst: 0, sgst: 0, igst: 0 }
      });
    } catch (err) {
      setHsnProductDetailError(err.response?.data?.error || err.message || 'Unable to load product sale details.');
    } finally {
      setHsnProductDetailLoading(false);
    }
  }

  async function loadProductSales(searchText = productSalesSearch) {
    const search = String(searchText || '').trim();
    if (!search) {
      setProductSalesError('Enter product code, barcode, or product name.');
      setProductSalesReport({ rows: [], totals: { bills: 0, quantity: 0, gross: 0, cash: 0, upi: 0, card: 0, other: 0 } });
      return;
    }

    const { from, to } = getOrderedRange(fromDate, toDate);
    setProductSalesLoading(true);
    setProductSalesError('');
    try {
      const data = await fetchProductSalesReport({ from, to, search });
      setProductSalesReport({
        rows: data.rows || [],
        totals: data.totals || { bills: 0, quantity: 0, gross: 0, cash: 0, upi: 0, card: 0, other: 0 }
      });
    } catch (err) {
      setProductSalesError(err.response?.data?.error || err.message || 'Unable to load product sales.');
    } finally {
      setProductSalesLoading(false);
    }
  }

  async function handleProductSalesSubmit(event) {
    event.preventDefault();
    await loadProductSales();
  }

  async function selectProductSalesSuggestion(product) {
    const searchText = product.barcode || product.product_code || product.product_name || '';
    setProductSalesSearch(searchText);
    setProductSalesSuggestions([]);
    setIsProductSalesSuggestionOpen(false);
    await loadProductSales(searchText);
  }

  async function loadSelectedReport(reportKey = activeReport, range = getOrderedRange(fromDate, toDate)) {
    const { from, to } = range;
    switch (reportKey) {
      case 'hsn': {
        const hsn = await fetchGstHsnReport({ from, to });
        setHsnReport(hsn);
        return;
      }
      case 'monthly': {
        const monthly = await fetchMonthlySalesReport(from.slice(0, 7));
        setMonthlyReport(monthly);
        return;
      }
      case 'stock': {
        const stock = await fetchStockReport(false);
        setStockReport(stock);
        return;
      }
      case 'top': {
        const top = await fetchTopProductsReport({ from, to });
        setTopProducts(top);
        return;
      }
      case 'productSales': {
        if (productSalesSearch.trim()) {
          await loadProductSales(productSalesSearch);
        }
        return;
      }
      case 'tax': {
        const tax = await fetchTaxSummaryReport({ from, to });
        setTaxSummary(tax);
        return;
      }
      case 'gstr':
      case 'gstr1': {
        const [gstr1, gstr2, gstr3] = await Promise.all([
          fetchGstr1Report({ from, to }),
          fetchGstr2Report({ from, to }),
          fetchGstr3Report({ from, to })
        ]);
        setGstr1Report(gstr1);
        setGstr2Report(gstr2);
        setGstr3Report(gstr3);
        return;
      }
      case 'handover': {
        const handover = await fetchCounterHandoverReport({ from, to, counter });
        setCounterHandoverReport(handover);
        return;
      }
      case 'exchange': {
        const exchange = await fetchExchangeBillsReport({ from, to, counter });
        setExchangeReport(exchange);
        return;
      }
      case 'barcodePrints': {
        const barcodePrints = await fetchBarcodePrintLogs({ from, to, search: reportSearch });
        setBarcodePrintReport(barcodePrints);
        return;
      }
      case 'reprints': {
        const reprints = await fetchReprintReport({ from, to, counter, search: reportSearch });
        setReprintReport(reprints);
        return;
      }
      case 'returns':
      case 'cancelled': {
        const exceptions = await fetchExceptionReport({ from, to });
        setExceptionReport(exceptions);
        return;
      }
      case 'daily':
      default: {
        const daily = await fetchDailySalesReport({ from, to, counter });
        setDailyReport(daily);
      }
    }
  }

  async function refreshSelectedReport(reportKey = activeReport) {
    setErrorMessage('');
    setIsReportLoading(true);
    try {
      await loadSelectedReport(reportKey);
    } catch (err) {
      setErrorMessage(err.response?.data?.error || 'Unable to load selected report.');
    } finally {
      setIsReportLoading(false);
    }
  }

  async function loadReports() {
    setErrorMessage('');
    setIsReportLoading(true);
    const { from, to } = getOrderedRange(fromDate, toDate);
    try {
      const daily = await fetchDailySalesReport({ from, to, counter });
      setDailyReport(daily);
      if (activeReport !== 'daily') {
        await loadSelectedReport(activeReport, { from, to });
      }
    } catch (err) {
      setErrorMessage(err.response?.data?.error || 'Unable to load reports from database.');
    } finally {
      setIsReportLoading(false);
    }
  }

  function handleReportFilterSubmit(event) {
    event.preventDefault();
    openSelectedReport(loadReports);
  }

  async function openSelectedReport(loader = () => refreshSelectedReport(activeReport)) {
    setIsReportOpen(true);
    await loader();
  }

  function setTopProductsSort(key, direction) {
    setTopProductSort({ key, direction });
  }

  function renderTopProductSortHeader(key) {
    const label = TOP_PRODUCT_SORT_LABELS[key];
    const isAscActive = topProductSort.key === key && topProductSort.direction === 'asc';
    const isDescActive = topProductSort.key === key && topProductSort.direction === 'desc';
    return (
      <div className="sortable-report-header">
        <span>{label}</span>
        <span className="sort-arrow-group" aria-label={`${label} sort`}>
          <button
            className={`sort-arrow-button sort-arrow-up ${isDescActive ? 'active' : ''}`}
            type="button"
            title={`${label} high to low`}
            aria-label={`${label} high to low`}
            onClick={() => setTopProductsSort(key, 'desc')}
          >
            ↑
          </button>
          <button
            className={`sort-arrow-button sort-arrow-down ${isAscActive ? 'active' : ''}`}
            type="button"
            title={`${label} low to high`}
            aria-label={`${label} low to high`}
            onClick={() => setTopProductsSort(key, 'asc')}
          >
            ↓
          </button>
        </span>
      </div>
    );
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
    { key: 'productSales', title: 'Product Sales', note: `${productSalesReport.rows.length} entries` },
    { key: 'tax', title: 'Tax Summary', note: `${taxSummary.rows.length} GST slabs` },
    { key: 'gstr', title: 'GSTR-1, 2, 3B Returns', note: `${(gstr1Report.b2b?.length || 0) + (gstr1Report.b2cl?.length || 0) + (gstr1Report.b2c?.length || 0) + (gstr2Report.b2b?.length || 0) + (gstr3Report.outward?.length || 0) + (gstr3Report.inward?.length || 0)} rows${gstCheckIssueCount ? `, ${gstCheckIssueCount} checks` : ''}` },
    { key: 'handover', title: 'Counter Handover', note: `${counterHandoverReport.totals?.sheets || 0} sheets` },
    { key: 'exchange', title: 'Exchange Bills', note: `${exchangeReport.totals?.billCount || 0} bills` },
    { key: 'reprints', title: 'Reprints', note: `${reprintReport.totals?.count || 0} prints` },
    { key: 'barcodePrints', title: 'Barcode Stickers', note: `${barcodePrintReport.totals?.stickers || 0} stickers` },
    { key: 'returns', title: 'Returns', note: `${exceptionReport.returns.length} returns` },
    { key: 'cancelled', title: 'Cancelled Bills', note: `${exceptionReport.cancelled.length} bills` }
  ];
  const selectedReportOption = reportOptions.find((report) => report.key === activeReport) || reportOptions[0];

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
    exportRows('gst_hsn_summary', filteredHsnRows.map((row) => ({
      HSN: row.hsn_code || '-',
      'Product Code': row.product_code || '',
      'Product Name': row.product_name || '',
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
    exportRows('top_products', sortedTopProductRows.map((row) => ({
      Barcode: row.barcode,
      Product: row.product_name,
      Qty: Number(row.quantity || 0),
      Total: Number(row.total || 0)
    })));
  }

  function exportProductSalesExcel() {
    exportRows('product_sales', (productSalesReport.rows || []).map((row) => ({
      Date: row.sale_date || '',
      Time: row.sale_time || '',
      'Bill No': row.invoice_no || '',
      Counter: row.billing_counter || '',
      Payment: row.payment_mode || '',
      Barcode: row.barcode || '',
      'Product Code': row.product_code || '',
      Product: row.product_name || '',
      Qty: Number(row.quantity || 0),
      Rate: Number(row.sale_price || 0),
      Total: Number(row.gross_total || 0),
      Cash: Number(row.cash_amount || 0),
      UPI: Number(row.upi_amount || 0),
      Card: Number(row.card_amount || 0),
      Other: Number(row.other_amount || 0)
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

  function exportGstrReturnsExcel() {
    const { from, to } = getOrderedRange(fromDate, toDate);
    exportWorkbook(reportFileName('gstr_1_2_3_returns', from, to), [
      {
        name: 'GSTR1 4A B2B',
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
        name: 'GSTR1 5A B2CL',
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
        name: 'GSTR1 7 B2CS',
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
        name: 'GSTR1 HSN B2B',
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
        name: 'GSTR1 HSN B2C',
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
        name: 'GSTR1 Nil Exempt',
        rows: (gstr1Report.nilExempt || []).map((row) => ({
          'Description': row.supply_type,
          'Nil Rated Supplies': Number(row.nil_rated_value || 0),
          'Exempted Other than Nil': 0,
          'Non GST Supplies': 0
        }))
      },
      {
        name: 'GSTR1 Documents',
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
      },
      {
        name: 'GSTR2 B2B Purchases',
        rows: (gstr2Report.b2b || []).map((row) => ({
          'GSTIN/UIN of Supplier': row.supplier_gstin || '',
          'Supplier Name': row.supplier_name || '',
          'Supplier Invoice No': row.supplier_invoice_no || row.inward_no,
          'Invoice Date': row.invoice_date || '',
          'Inward No': row.inward_no || '',
          'Invoice Value': Number(row.invoice_value || 0),
          'Place Of Supply': row.supplier_gstin ? `${String(row.supplier_gstin).slice(0, 2)}-State` : '',
          Rate: Number(row.gst_percent || 0),
          'Taxable Value': Number(row.taxable_value || 0),
          CGST: Number(row.cgst || 0),
          SGST: Number(row.sgst || 0),
          IGST: Number(row.igst || 0),
          'ITC Eligible': 'Y'
        }))
      },
      {
        name: 'GSTR2 HSN Input',
        rows: (gstr2Report.hsn || []).map((row) => ({
          'HSN Code': row.hsn_code || '-',
          UQC: 'NOS',
          'Total Quantity': Number(row.quantity || 0),
          'Total Value': Number(row.total_value || 0),
          Rate: Number(row.gst_percent || 0),
          'Taxable Value': Number(row.taxable_value || 0),
          CGST: Number(row.cgst || 0),
          SGST: Number(row.sgst || 0),
          IGST: Number(row.igst || 0)
        }))
      },
      {
        name: 'GSTR3 Output Tax',
        rows: (gstr3Report.outward || []).map((row) => ({
          Type: 'Outward Supplies',
          'GST %': Number(row.gst_percent || 0),
          Taxable: Number(row.taxable || 0),
          CGST: Number(row.cgst || 0),
          SGST: Number(row.sgst || 0),
          IGST: Number(row.igst || 0),
          Tax: Number(row.tax || 0),
          Total: Number(row.total || 0)
        }))
      },
      {
        name: 'GSTR3 Input Tax',
        rows: (gstr3Report.inward || []).map((row) => ({
          Type: 'Inward Supplies',
          'GST %': Number(row.gst_percent || 0),
          Taxable: Number(row.taxable || 0),
          CGST: Number(row.cgst || 0),
          SGST: Number(row.sgst || 0),
          IGST: Number(row.igst || 0),
          Tax: Number(row.tax || 0),
          Total: Number(row.total || 0)
        }))
      },
      {
        name: 'GSTR3 Payable Summary',
        rows: [{
          'Output Taxable': Number(gstr3Report.totals?.outwardTaxable || 0),
          'Output Tax': Number(gstr3Report.totals?.outwardTax || 0),
          'Input Taxable': Number(gstr3Report.totals?.inwardTaxable || 0),
          'Input Tax Credit': Number(gstr3Report.totals?.inputTax || 0),
          'GST Payable': Number(gstr3Report.totals?.payable || 0),
          Status: Number(gstr3Report.totals?.payable || 0) >= 0 ? 'Payable' : 'Input Credit'
        }]
      },
      {
        name: 'GSTR3B Outward',
        rows: (gstr3Report.threeB?.outward || []).map((row) => ({
          Section: row.section,
          Taxable: Number(row.taxable || 0),
          IGST: Number(row.igst || 0),
          CGST: Number(row.cgst || 0),
          SGST: Number(row.sgst || 0),
          Cess: Number(row.cess || 0)
        }))
      },
      {
        name: 'GSTR3B ITC',
        rows: (gstr3Report.threeB?.itc || []).map((row) => ({
          Section: row.section,
          IGST: Number(row.igst || 0),
          CGST: Number(row.cgst || 0),
          SGST: Number(row.sgst || 0),
          Cess: Number(row.cess || 0)
        }))
      },
      {
        name: 'GST Filing Checks',
        rows: [
          { Check: 'Sales items missing HSN', Count: (gstr3Report.checks?.missingSalesHsn || []).length },
          { Check: 'Purchase items missing HSN', Count: (gstr3Report.checks?.missingPurchaseHsn || []).length },
          { Check: 'B2B sales missing customer GSTIN', Count: (gstr3Report.checks?.missingB2bGstin || []).length },
          { Check: 'Purchases missing supplier GSTIN', Count: (gstr3Report.checks?.missingSupplierGstin || []).length },
          { Check: 'Sales total mismatch', Count: (gstr3Report.checks?.salesMismatch || []).length },
          { Check: 'Purchase total mismatch', Count: (gstr3Report.checks?.purchaseMismatch || []).length }
        ]
      },
      {
        name: 'Missing Sales HSN',
        rows: gstr3Report.checks?.missingSalesHsn || []
      },
      {
        name: 'Missing Purchase HSN',
        rows: gstr3Report.checks?.missingPurchaseHsn || []
      },
      {
        name: 'Missing GSTIN',
        rows: [
          ...(gstr3Report.checks?.missingB2bGstin || []).map((row) => ({ Type: 'B2B Sale', ...row })),
          ...(gstr3Report.checks?.missingSupplierGstin || []).map((row) => ({ Type: 'Purchase', ...row }))
        ]
      }
    ]);
  }

  function exportCounterHandoverExcel() {
    const { from, to } = getOrderedRange(fromDate, toDate);
    const rows = counterHandoverReport.rows || [];
    const summaryRows = rows.map((row) => ({
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
    }));
    const manualRows = rows.flatMap((row) => (row.entries || [])
      .filter((entry) => !isHandoverAutoEntry(entry))
      .map((entry) => ({
        Date: row.closing_date,
        Counter: row.counter_no,
        Sheet: row.sheet_no,
        Line: Number(entry.line_no || 0),
        Type: entry.entry_type || '',
        Details: entry.details || '',
        Remarks: entry.remarks || '',
        Direction: entry.direction || '',
        DR: entry.direction === 'DR' ? Number(entry.amount || 0) : 0,
        CR: entry.direction === 'CR' ? Number(entry.amount || 0) : 0
      })));
    const entryRows = rows.flatMap((row) => (row.entries || []).map((entry) => ({
      Date: row.closing_date,
      Counter: row.counter_no,
      Sheet: row.sheet_no,
      Line: Number(entry.line_no || 0),
      Type: entry.entry_type || '',
      Details: entry.details || '',
      Remarks: entry.remarks || '',
      Direction: entry.direction || '',
      Amount: Number(entry.amount || 0)
    })));
    const denominationRows = rows.map((row) => {
      const byValue = (row.denominations || []).reduce((acc, item) => {
        acc[Number(item.denomination_value)] = Number(item.quantity || 0);
        return acc;
      }, {});
      return HANDOVER_DENOMINATIONS.reduce((acc, value) => {
        acc[`${value} Qty`] = byValue[value] || '';
        return acc;
      }, {
        Date: row.closing_date,
        Counter: row.counter_no,
        Sheet: row.sheet_no,
        'Cash Notes Balance': Number(row.cash_balance || 0)
      });
    });

    exportWorkbook(reportFileName('counter_handover', from, to), [
      { name: 'Summary', rows: summaryRows },
      { name: 'Manual Entries', rows: manualRows },
      { name: 'All Sheet Lines', rows: entryRows },
      { name: 'Cash Notes', rows: denominationRows }
    ]);
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
            <ReportHeader title="GST HSN-wise Summary" onExcel={exportHsnExcel} onPdf={exportPdf} onClose={() => setIsReportOpen(false)} />
            <div className="panel-body">
              <div className="report-filter-row hsn-summary-controls">
                <label className="hsn-summary-field">
                  <span className="field-label">HSN</span>
                  <select
                    className="select"
                    value={hsnFilters.hsnRange}
                    onChange={(event) => setHsnFilters((current) => ({ ...current, hsnRange: event.target.value }))}
                  >
                    {HSN_RANGE_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value}>{option.label}</option>
                    ))}
                  </select>
                </label>
                <label className="hsn-summary-field">
                  <span className="field-label">GST %</span>
                  <select
                    className="select"
                    value={hsnFilters.gstPercent}
                    onChange={(event) => setHsnFilters((current) => ({ ...current, gstPercent: event.target.value }))}
                  >
                    {GST_PERCENT_OPTIONS.map((percent) => (
                      <option key={percent} value={percent}>{percent === 'ALL' ? 'All GST' : `${percent}%`}</option>
                    ))}
                  </select>
                </label>
                <label className="hsn-summary-product-field">
                  <span className="field-label">Product</span>
                  <input
                    className="field"
                    value={hsnFilters.productSearch}
                    onChange={(event) => setHsnFilters((current) => ({ ...current, productSearch: event.target.value }))}
                    placeholder="Code / name"
                  />
                </label>
                <label className="hsn-summary-field">
                  <span className="field-label">Qty</span>
                  <select
                    className="select"
                    value={hsnFilters.qtySort}
                    onChange={(event) => setHsnFilters((current) => ({ ...current, qtySort: event.target.value }))}
                  >
                    {QTY_SORT_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value}>{option.label}</option>
                    ))}
                  </select>
                </label>
                <button className="secondary-button" type="button" onClick={() => setHsnFilters(DEFAULT_HSN_FILTERS)}>Clear</button>
                <span className="status-chip">{filteredHsnRows.length} rows</span>
                {filteredHsnRows.length > HSN_VISIBLE_ROW_LIMIT ? (
                  <span className="status-chip warning">Showing first {HSN_VISIBLE_ROW_LIMIT}</span>
                ) : null}
                <div className="hsn-summary-total-box">
                  <span>Gross</span>
                  <strong>{formatMoney(filteredHsnTotals.gross)}</strong>
                </div>
                <div className="hsn-summary-total-box">
                  <span>CGST</span>
                  <strong>{formatMoney(filteredHsnTotals.cgst)}</strong>
                </div>
                <div className="hsn-summary-total-box">
                  <span>SGST</span>
                  <strong>{formatMoney(filteredHsnTotals.sgst)}</strong>
                </div>
                <div className="hsn-summary-total-box">
                  <span>IGST</span>
                  <strong>{formatMoney(filteredHsnTotals.igst)}</strong>
                </div>
              </div>
              <div className="hsn-product-detail-box">
                <form className="report-filter-row hsn-product-detail-form" onSubmit={handleHsnProductDetailSubmit}>
                  <label className="hsn-product-detail-search supplier-lookup-field">
                    <span className="field-label">Product Sale Details</span>
                    <input
                      className="field"
                      value={hsnProductSearch}
                      onChange={(event) => {
                        setHsnProductSearch(event.target.value);
                        setIsHsnProductSuggestionOpen(event.target.value.trim().length >= 3);
                      }}
                      onFocus={() => {
                        if (hsnProductSuggestions.length) setIsHsnProductSuggestionOpen(true);
                      }}
                      placeholder="Product code / barcode / product name"
                    />
                    {isHsnProductSuggestionOpen && hsnProductSuggestions.length > 0 && (
                      <div className="supplier-suggestions">
                        {hsnProductSuggestions.map((product) => (
                          <button key={product.barcode} type="button" className="supplier-suggestion-row" onClick={() => selectHsnProduct(product)}>
                            <strong>{product.product_name}</strong>
                            <span>{product.barcode} | Code {product.product_code || '-'} | HSN {product.hsn_code || '-'} | GST {Number(product.gst_percent || 0)}%</span>
                          </button>
                        ))}
                      </div>
                    )}
                  </label>
                  <button className="secondary-button" type="submit" disabled={hsnProductDetailLoading}>
                    {hsnProductDetailLoading ? 'Loading...' : 'Search'}
                  </button>
                  <span className="status-chip">{hsnProductDetails.rows.length} entries</span>
                  <div className="hsn-summary-total-box">
                    <span>Qty</span>
                    <strong>{Number(hsnProductDetails.totals?.quantity || 0)}</strong>
                  </div>
                  <div className="hsn-summary-total-box">
                    <span>Gross</span>
                    <strong>{formatMoney(hsnProductDetails.totals?.gross)}</strong>
                  </div>
                  <div className="hsn-summary-total-box">
                    <span>CGST</span>
                    <strong>{formatMoney(hsnProductDetails.totals?.cgst)}</strong>
                  </div>
                  <div className="hsn-summary-total-box">
                    <span>SGST</span>
                    <strong>{formatMoney(hsnProductDetails.totals?.sgst)}</strong>
                  </div>
                  <div className="hsn-summary-total-box">
                    <span>IGST</span>
                    <strong>{formatMoney(hsnProductDetails.totals?.igst)}</strong>
                  </div>
                </form>
                {hsnProductDetailError ? <div className="error-banner">{hsnProductDetailError}</div> : null}
                <table className="history-table hsn-product-detail-table">
                  <thead><tr><th>Date</th><th>Time</th><th>Invoice</th><th>Counter</th><th>Product Code</th><th>Product Name</th><th>HSN</th><th>GST %</th><th>Qty</th><th>Gross</th></tr></thead>
                  <tbody>
                    {hsnProductDetails.rows.length === 0 ? (
                      <tr><td colSpan="10">Search a product to view date/time/counter wise sale details.</td></tr>
                    ) : hsnProductDetails.rows.map((row, index) => (
                      <tr key={`${row.invoice_no}-${row.barcode}-${row.sale_time}-${index}`}>
                        <td>{row.sale_date || '-'}</td>
                        <td>{row.sale_time || '-'}</td>
                        <td>{row.invoice_no || '-'}</td>
                        <td>{row.billing_counter || '-'}</td>
                        <td>{row.product_code || row.barcode || '-'}</td>
                        <td>{row.product_name || '-'}</td>
                        <td>{row.hsn_code || '-'}</td>
                        <td>{Number(row.gst_percent || 0)}%</td>
                        <td>{Number(row.quantity || 0)}</td>
                        <td>{formatMoney(row.gross_total)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <table className="history-table">
                <thead><tr><th>HSN</th><th>Product Code</th><th>Product Name</th><th>GST %</th><th>Qty</th><th>Gross</th><th>CGST</th><th>SGST</th><th>IGST</th></tr></thead>
                <tbody>
                  {filteredHsnRows.length === 0 ? <tr><td colSpan="9">No GST data for selected filters/date range.</td></tr> : visibleHsnRows.map((row) => (
                    <tr key={`${row.hsn_code}-${row.product_code}-${row.product_name}-${row.gst_percent}`}><td>{row.hsn_code || '-'}</td><td>{row.product_code || '-'}</td><td>{row.product_name || '-'}</td><td>{Number(row.gst_percent || 0)}%</td><td>{Number(row.quantity || 0)}</td><td>{formatMoney(row.gross_total)}</td><td>{formatMoney(row.cgst)}</td><td>{formatMoney(row.sgst)}</td><td>{formatMoney(row.igst)}</td></tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        );
      case 'monthly':
        return (
          <section className="panel">
            <ReportHeader title="Monthly Sales" onExcel={exportMonthlyExcel} onPdf={exportPdf} onClose={() => setIsReportOpen(false)} />
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
            <ReportHeader title="Stock Report" onExcel={exportStockExcel} onPdf={exportPdf} onClose={() => setIsReportOpen(false)} />
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
            <ReportHeader title="Top Products" onExcel={exportTopProductsExcel} onPdf={exportPdf} onClose={() => setIsReportOpen(false)} />
            <div className="panel-body">
              <table className="history-table">
                <thead><tr><th>Barcode</th><th>Product</th><th>{renderTopProductSortHeader('quantity')}</th><th>{renderTopProductSortHeader('total')}</th></tr></thead>
                <tbody>
                  {sortedTopProductRows.length === 0 ? <tr><td colSpan="4">No product movement data.</td></tr> : sortedTopProductRows.map((row, index) => (
                    <tr key={`${row.barcode || 'no-barcode'}-${row.product_name || 'product'}-${index}`}><td className="mono">{row.barcode}</td><td>{row.product_name}</td><td>{Number(row.quantity || 0)}</td><td>{formatMoney(row.total)}</td></tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        );
      case 'productSales':
        return (
          <section className="panel">
            <ReportHeader title="Product Sales" onExcel={exportProductSalesExcel} onPdf={exportPdf} onClose={() => setIsReportOpen(false)} />
            <div className="panel-body form-stack">
              <form className="report-filter-row hsn-product-detail-form" onSubmit={handleProductSalesSubmit}>
                <label className="hsn-product-detail-search supplier-lookup-field">
                  <span className="field-label">Product Code / Name</span>
                  <input
                    className="field"
                    value={productSalesSearch}
                    onChange={(event) => {
                      setProductSalesSearch(event.target.value);
                      setIsProductSalesSuggestionOpen(event.target.value.trim().length >= 3);
                    }}
                    onFocus={() => {
                      if (productSalesSuggestions.length) setIsProductSalesSuggestionOpen(true);
                    }}
                    placeholder="Scan/type barcode, code, or product name"
                  />
                  {isProductSalesSuggestionOpen && productSalesSuggestions.length > 0 && (
                    <div className="supplier-suggestions">
                      {productSalesSuggestions.map((product) => (
                        <button key={product.barcode} type="button" className="supplier-suggestion-row" onClick={() => selectProductSalesSuggestion(product)}>
                          <strong>{product.product_name}</strong>
                          <span>{product.barcode} | Code {product.product_code || '-'} | GST {Number(product.gst_percent || 0)}%</span>
                        </button>
                      ))}
                    </div>
                  )}
                </label>
                <button className="secondary-button" type="submit" disabled={productSalesLoading}>
                  {productSalesLoading ? 'Loading...' : 'View'}
                </button>
                <button className="secondary-button" type="button" onClick={() => {
                  setProductSalesSearch('');
                  setProductSalesReport({ rows: [], totals: { bills: 0, quantity: 0, gross: 0, cash: 0, upi: 0, card: 0, other: 0 } });
                  setProductSalesError('');
                  setProductSalesSuggestions([]);
                  setIsProductSalesSuggestionOpen(false);
                }}>Clear</button>
                <span className="status-chip">{productSalesReport.rows.length} entries</span>
                <div className="hsn-summary-total-box"><span>Bills</span><strong>{Number(productSalesReport.totals?.bills || 0)}</strong></div>
                <div className="hsn-summary-total-box"><span>Qty</span><strong>{Number(productSalesReport.totals?.quantity || 0)}</strong></div>
                <div className="hsn-summary-total-box"><span>Total</span><strong>{formatMoney(productSalesReport.totals?.gross)}</strong></div>
                <div className="hsn-summary-total-box"><span>Cash</span><strong>{formatMoney(productSalesReport.totals?.cash)}</strong></div>
                <div className="hsn-summary-total-box"><span>UPI</span><strong>{formatMoney(productSalesReport.totals?.upi)}</strong></div>
                <div className="hsn-summary-total-box"><span>Card</span><strong>{formatMoney(productSalesReport.totals?.card)}</strong></div>
              </form>
              {productSalesError ? <div className="error-banner">{productSalesError}</div> : null}
              <table className="history-table hsn-product-detail-table">
                <thead><tr><th>Date</th><th>Time</th><th>Bill No</th><th>Counter</th><th>Payment</th><th>Product Code</th><th>Product</th><th>Qty</th><th>Rate</th><th>Total</th><th>Cash</th><th>UPI</th><th>Card</th></tr></thead>
                <tbody>
                  {productSalesReport.rows.length === 0 ? (
                    <tr><td colSpan="13">Search product code, barcode, or product name to view sale history.</td></tr>
                  ) : productSalesReport.rows.map((row, index) => (
                    <tr key={`${row.invoice_no}-${row.barcode}-${row.sale_time}-${index}`}>
                      <td>{row.sale_date || '-'}</td>
                      <td>{row.sale_time || '-'}</td>
                      <td className="mono">{row.invoice_no || '-'}</td>
                      <td>{row.billing_counter || '-'}</td>
                      <td>{row.payment_mode || '-'}</td>
                      <td>{row.product_code || row.barcode || '-'}</td>
                      <td>{row.product_name || '-'}</td>
                      <td>{Number(row.quantity || 0)}</td>
                      <td>{formatMoney(row.sale_price)}</td>
                      <td><strong>{formatMoney(row.gross_total)}</strong></td>
                      <td>{formatMoney(row.cash_amount)}</td>
                      <td>{formatMoney(row.upi_amount)}</td>
                      <td>{formatMoney(row.card_amount)}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot><tr><th>Total</th><th></th><th>{Number(productSalesReport.totals?.bills || 0)} bills</th><th></th><th></th><th></th><th></th><th>{Number(productSalesReport.totals?.quantity || 0)}</th><th></th><th>{formatMoney(productSalesReport.totals?.gross)}</th><th>{formatMoney(productSalesReport.totals?.cash)}</th><th>{formatMoney(productSalesReport.totals?.upi)}</th><th>{formatMoney(productSalesReport.totals?.card)}</th></tr></tfoot>
              </table>
            </div>
          </section>
        );
      case 'tax':
        return (
          <section className="panel">
            <ReportHeader title="Tax Summary" onExcel={exportTaxExcel} onPdf={exportPdf} onClose={() => setIsReportOpen(false)} />
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
      case 'gstr':
      case 'gstr1':
        return (
          <section className="panel">
            <ReportHeader title="GSTR-1, GSTR-2, GSTR-3B Returns" onExcel={exportGstrReturnsExcel} onPdf={exportPdf} onClose={() => setIsReportOpen(false)} />
            <div className="panel-body form-stack">
              <div className="alert-box">
                GST filing review format: verify GSTIN, supplier invoices, place of supply, HSN/UQC, input tax credit and payable values before uploading to GST portal/offline utility.
              </div>
              <section>
                <h3 className="panel-title">GSTR-1 - Outward Supplies</h3>
              </section>
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

              <section>
                <h3 className="panel-title">GSTR-2 - B2B Purchase / Input GST</h3>
                <table className="history-table">
                  <thead><tr><th>Supplier GSTIN</th><th>Supplier</th><th>Supplier Invoice</th><th>Date</th><th>Inward No</th><th>Rate</th><th>Taxable</th><th>CGST</th><th>SGST</th><th>IGST</th><th>Invoice Value</th></tr></thead>
                  <tbody>
                    {(gstr2Report.b2b || []).length === 0 ? <tr><td colSpan="11">No purchase/input GST data found.</td></tr> : gstr2Report.b2b.map((row, index) => (
                      <tr key={`${row.inward_no}-${row.gst_percent}-${index}`}><td>{row.supplier_gstin || '-'}</td><td>{row.supplier_name || '-'}</td><td>{row.supplier_invoice_no || '-'}</td><td>{row.invoice_date || '-'}</td><td>{row.inward_no || '-'}</td><td>{Number(row.gst_percent || 0)}%</td><td>{formatMoney(row.taxable_value)}</td><td>{formatMoney(row.cgst)}</td><td>{formatMoney(row.sgst)}</td><td>{formatMoney(row.igst)}</td><td>{formatMoney(row.invoice_value)}</td></tr>
                    ))}
                  </tbody>
                </table>
              </section>

              <section>
                <h3 className="panel-title">GSTR-2 - HSN Input Summary</h3>
                <table className="history-table">
                  <thead><tr><th>HSN</th><th>UQC</th><th>Rate</th><th>Qty</th><th>Taxable</th><th>CGST</th><th>SGST</th><th>IGST</th><th>Total</th></tr></thead>
                  <tbody>
                    {(gstr2Report.hsn || []).length === 0 ? <tr><td colSpan="9">No purchase HSN data found.</td></tr> : gstr2Report.hsn.map((row) => (
                      <tr key={`${row.hsn_code}-${row.gst_percent}`}><td>{row.hsn_code || '-'}</td><td>NOS</td><td>{Number(row.gst_percent || 0)}%</td><td>{Number(row.quantity || 0)}</td><td>{formatMoney(row.taxable_value)}</td><td>{formatMoney(row.cgst)}</td><td>{formatMoney(row.sgst)}</td><td>{formatMoney(row.igst)}</td><td>{formatMoney(row.total_value)}</td></tr>
                    ))}
                  </tbody>
                </table>
              </section>

              <section>
                <h3 className="panel-title">GSTR-3B Payable Summary - Output vs Input GST</h3>
                <table className="history-table">
                  <thead><tr><th>Book</th><th>GST %</th><th>Taxable</th><th>CGST</th><th>SGST</th><th>IGST</th><th>Tax</th><th>Total</th></tr></thead>
                  <tbody>
                    {[...(gstr3Report.outward || []).map((row) => ({ ...row, book: 'Outward Supplies' })), ...(gstr3Report.inward || []).map((row) => ({ ...row, book: 'Input Tax Credit' }))].length === 0 ? <tr><td colSpan="8">No GSTR-3B summary data found.</td></tr> : [...(gstr3Report.outward || []).map((row) => ({ ...row, book: 'Outward Supplies' })), ...(gstr3Report.inward || []).map((row) => ({ ...row, book: 'Input Tax Credit' }))].map((row, index) => (
                      <tr key={`${row.book}-${row.gst_percent}-${index}`}><td>{row.book}</td><td>{Number(row.gst_percent || 0)}%</td><td>{formatMoney(row.taxable)}</td><td>{formatMoney(row.cgst)}</td><td>{formatMoney(row.sgst)}</td><td>{formatMoney(row.igst)}</td><td>{formatMoney(row.tax)}</td><td>{formatMoney(row.total)}</td></tr>
                    ))}
                  </tbody>
                </table>
              </section>

              <section className="report-summary-strip">
                <span>Output Tax: <strong>{formatMoney(gstr3Report.totals?.outwardTax || 0)}</strong></span>
                <span>Input Tax Credit: <strong>{formatMoney(gstr3Report.totals?.inputTax || 0)}</strong></span>
                <span>{Number(gstr3Report.totals?.payable || 0) >= 0 ? 'GST Payable' : 'Input Credit'}: <strong>{formatMoney(Math.abs(Number(gstr3Report.totals?.payable || 0)))}</strong></span>
              </section>

              <section>
                <h3 className="panel-title">GSTR-3B - 3.1 Outward Supplies</h3>
                <table className="history-table">
                  <thead><tr><th>Section</th><th>Taxable</th><th>IGST</th><th>CGST</th><th>SGST</th><th>Cess</th></tr></thead>
                  <tbody>
                    {(gstr3Report.threeB?.outward || []).length === 0 ? <tr><td colSpan="6">No GSTR-3B outward data found.</td></tr> : gstr3Report.threeB.outward.map((row) => (
                      <tr key={row.section}><td>{row.section}</td><td>{formatMoney(row.taxable)}</td><td>{formatMoney(row.igst)}</td><td>{formatMoney(row.cgst)}</td><td>{formatMoney(row.sgst)}</td><td>{formatMoney(row.cess)}</td></tr>
                    ))}
                  </tbody>
                </table>
              </section>

              <section>
                <h3 className="panel-title">GSTR-3B - 4 Eligible ITC</h3>
                <table className="history-table">
                  <thead><tr><th>Section</th><th>IGST</th><th>CGST</th><th>SGST</th><th>Cess</th></tr></thead>
                  <tbody>
                    {(gstr3Report.threeB?.itc || []).length === 0 ? <tr><td colSpan="5">No ITC data found.</td></tr> : gstr3Report.threeB.itc.map((row) => (
                      <tr key={row.section}><td>{row.section}</td><td>{formatMoney(row.igst)}</td><td>{formatMoney(row.cgst)}</td><td>{formatMoney(row.sgst)}</td><td>{formatMoney(row.cess)}</td></tr>
                    ))}
                  </tbody>
                </table>
              </section>

              <section className="report-summary-strip">
                <span>Missing Sales HSN: <strong>{(gstr3Report.checks?.missingSalesHsn || []).length}</strong></span>
                <span>Missing Purchase HSN: <strong>{(gstr3Report.checks?.missingPurchaseHsn || []).length}</strong></span>
                <span>B2B GSTIN Missing: <strong>{(gstr3Report.checks?.missingB2bGstin || []).length}</strong></span>
                <span>Supplier GSTIN Missing: <strong>{(gstr3Report.checks?.missingSupplierGstin || []).length}</strong></span>
                <span>Total Mismatch: <strong>{(gstr3Report.checks?.salesMismatch || []).length + (gstr3Report.checks?.purchaseMismatch || []).length}</strong></span>
              </section>

              <section>
                <h3 className="panel-title">GST Filing Checks</h3>
                <table className="history-table">
                  <thead><tr><th>Check</th><th>Count</th><th>Action</th></tr></thead>
                  <tbody>
                    {[
                      ['Sales items missing HSN', (gstr3Report.checks?.missingSalesHsn || []).length, 'Update product HSN before filing GSTR-1.'],
                      ['Purchase items missing HSN', (gstr3Report.checks?.missingPurchaseHsn || []).length, 'Update inward/product HSN before claiming ITC.'],
                      ['B2B sales missing customer GSTIN', (gstr3Report.checks?.missingB2bGstin || []).length, 'Add customer GSTIN or move invoice to B2C.'],
                      ['Purchases missing supplier GSTIN', (gstr3Report.checks?.missingSupplierGstin || []).length, 'Add supplier GSTIN for input-credit review.'],
                      ['Sales total mismatch', (gstr3Report.checks?.salesMismatch || []).length, 'Verify invoice item totals against bill total.'],
                      ['Purchase total mismatch', (gstr3Report.checks?.purchaseMismatch || []).length, 'Verify inward item totals against purchase total.']
                    ].map(([label, count, action]) => (
                      <tr key={label}><td>{label}</td><td>{count}</td><td>{action}</td></tr>
                    ))}
                  </tbody>
                </table>
              </section>
            </div>
          </section>
        );
      case 'returns':
        return (
          <section className="panel">
            <ReportHeader title="Returns" onExcel={exportReturnsExcel} onPdf={exportPdf} onClose={() => setIsReportOpen(false)} />
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
            <ReportHeader title="Exchange Bills Report" onExcel={exportExchangeExcel} onPdf={exportPdf} onClose={() => setIsReportOpen(false)} />
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
            <ReportHeader title="Counter Handover Report" onExcel={exportCounterHandoverExcel} onPdf={exportPdf} onClose={() => setIsReportOpen(false)} />
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
              {(counterHandoverReport.rows || []).map((row) => {
                const manualEntries = (row.entries || []).filter((entry) => !isHandoverAutoEntry(entry));
                const denominationQty = (row.denominations || []).reduce((acc, item) => {
                  acc[Number(item.denomination_value)] = Number(item.quantity || 0);
                  return acc;
                }, {});
                return (
                  <section key={`${row.sheet_no}-details`} className="form-stack">
                    <h3 className="panel-title">{row.sheet_no} - Counter {row.counter_no} Sheet Details</h3>
                    <table className="history-table">
                      <thead><tr><th>Line</th><th>Details</th><th>Remarks</th><th>DR</th><th>CR</th></tr></thead>
                      <tbody>
                        {(row.entries || []).length === 0 ? (
                          <tr><td colSpan="5">No sheet lines saved.</td></tr>
                        ) : row.entries.map((entry, index) => (
                          <tr key={`${row.sheet_no}-entry-${index}`}>
                            <td>{entry.line_no || index + 1}</td>
                            <td>{entry.details || '-'}</td>
                            <td>{entry.remarks || '-'}</td>
                            <td>{entry.direction === 'DR' ? formatMoney(entry.amount) : '-'}</td>
                            <td>{entry.direction === 'CR' ? formatMoney(entry.amount) : '-'}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    <table className="history-table">
                      <thead><tr><th>Manual Entry</th><th>Remarks</th><th>Direction</th><th>Amount</th></tr></thead>
                      <tbody>
                        {manualEntries.length === 0 ? (
                          <tr><td colSpan="4">No daily expense / bank cash manual entries saved for this sheet.</td></tr>
                        ) : manualEntries.map((entry, index) => (
                          <tr key={`${row.sheet_no}-manual-${index}`}>
                            <td>{entry.details || '-'}</td>
                            <td>{entry.remarks || '-'}</td>
                            <td>{entry.direction || '-'}</td>
                            <td>{formatMoney(entry.amount)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    <table className="history-table">
                      <thead>
                        <tr>
                          {HANDOVER_DENOMINATIONS.map((value) => <th key={value}>{value} Qty</th>)}
                          <th>Cash Notes Balance</th>
                        </tr>
                      </thead>
                      <tbody>
                        <tr>
                          {HANDOVER_DENOMINATIONS.map((value) => <td key={value}>{denominationQty[value] || '-'}</td>)}
                          <td><strong>{formatMoney(row.cash_balance)}</strong></td>
                        </tr>
                      </tbody>
                    </table>
                  </section>
                );
              })}
            </div>
          </section>
        );
      case 'barcodePrints':
        return (
          <section className="panel">
            <ReportHeader title="Barcode Sticker Print Report" onExcel={exportBarcodePrintsExcel} onPdf={exportPdf} onClose={() => setIsReportOpen(false)} />
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
            <ReportHeader title="Bill Reprints Report" onExcel={exportReprintsExcel} onPdf={exportPdf} onClose={() => setIsReportOpen(false)} />
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
            <ReportHeader title="Cancelled Bills" onExcel={exportCancelledExcel} onPdf={exportPdf} onClose={() => setIsReportOpen(false)} />
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
            <ReportHeader title="Daily Sales Report" onExcel={exportDailyExcel} onPdf={exportPdf} onClose={() => setIsReportOpen(false)} />
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
            <label className="report-counter-field">
              <span className="field-label">Counter</span>
              <select className="select" value={counter} onChange={(event) => setCounter(event.target.value)}>
                <option value="">All Counters</option>
                {counterOptions.map((option) => <option key={option} value={option}>{option}</option>)}
              </select>
            </label>
            <label className="date-range-field">
              <span className="field-label">Search</span>
              <input
                className="field"
                value={reportSearch}
                onChange={(event) => setReportSearch(event.target.value)}
                placeholder="Invoice / customer / barcode / user"
              />
            </label>
            <button className="secondary-button" type="button" onClick={() => openSelectedReport(loadReports)} disabled={isReportLoading}>
              {isReportLoading ? 'Loading...' : 'View'}
            </button>
            <button className="close-action-button" type="button" onClick={onClose}>Close</button>
          </form>

          <div className="report-selector-grid">
            {reportOptions.map((report) => (
              <button
                key={report.key}
                className={`report-select-card ${activeReport === report.key ? 'active' : ''}`}
                type="button"
                onClick={() => {
                  if (report.key === 'gstr' || report.key === 'handover') {
                    setFromDate(currentMonthStartIso());
                    setToDate(todayIso());
                  }
                  setActiveReport(report.key);
                }}
              >
                <strong>{report.title}</strong>
                <span>{report.note}</span>
              </button>
            ))}
          </div>
          <div className="report-selector-actions">
            <span className="selected-report-label">Selected: <strong>{selectedReportOption.title}</strong></span>
            <button className="primary-button" type="button" onClick={() => openSelectedReport()} disabled={isReportLoading}>
              {isReportLoading ? 'Loading...' : 'View'}
            </button>
            <button className="close-action-button" type="button" onClick={onClose}>Close</button>
          </div>
        </div>
      </section>

      {isReportOpen && <div
        className="reports-print-area report-view-modal-backdrop"
        role="dialog"
        aria-modal="true"
        aria-label={`${selectedReportOption.title} report view`}
        onMouseDown={(event) => {
          if (event.target === event.currentTarget) setIsReportOpen(false);
        }}
      >
        <div className="report-view-modal">
          <div className="report-view-sticky-toolbar">
            <strong className="report-view-modal-title">{selectedReportOption.title}</strong>
            <label className="report-view-date-field">
              <span>From Date</span>
              <input className="field report-date-input" type="date" value={fromDate} onChange={(event) => setFromDate(event.target.value)} />
            </label>
            <label className="report-view-date-field">
              <span>To Date</span>
              <input className="field report-date-input" type="date" value={toDate} onChange={(event) => setToDate(event.target.value)} />
            </label>
            <button className="primary-button" type="button" onClick={() => openSelectedReport(loadReports)} disabled={isReportLoading}>
              {isReportLoading ? 'Loading...' : 'View Dates'}
            </button>
            <button className="close-action-button" type="button" onClick={() => setIsReportOpen(false)}>Close</button>
          </div>
          <div className="report-view-scroll" onClick={(event) => {
            if (event.target.closest('.report-print-trigger')) printReport();
          }}>
            {renderSelectedReport()}
          </div>
        </div>
      </div>}
    </div>
  );
}
