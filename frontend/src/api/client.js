import axios from 'axios';

const api = axios.create({
  baseURL: process.env.REACT_APP_API_BASE_URL || 'http://localhost:5000/api',
  timeout: 10000
});

api.interceptors.request.use((config) => {
  const token = window.localStorage.getItem('badizo_token');
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

export function setAuthSession(token, user) {
  window.localStorage.setItem('badizo_token', token);
  window.localStorage.setItem('badizo_user', JSON.stringify(user));
}

export function clearAuthSession() {
  window.localStorage.removeItem('badizo_token');
  window.localStorage.removeItem('badizo_user');
}

export function getStoredUser() {
  const rawUser = window.localStorage.getItem('badizo_user');
  if (!rawUser) return null;

  try {
    return JSON.parse(rawUser);
  } catch (err) {
    return null;
  }
}

export async function login(username, password) {
  const { data } = await api.post('/auth/login', { username, password });
  setAuthSession(data.token, data.user);
  return data.user;
}

export async function approveSensitiveBillingMode({ username, password, reason }) {
  const { data } = await api.post('/auth/approve-sensitive-mode', { username, password, reason });
  return data;
}

export async function searchProducts(query) {
  const trimmed = String(query || '').trim();
  if (!trimmed) return [];

  const { data } = await api.get(`/products/search/${encodeURIComponent(trimmed)}`);
  return Array.isArray(data) ? data : [];
}

export async function fetchProducts({ page = 1, limit = 50, search = '', gst = 'ALL' } = {}) {
  const { data } = await api.get('/products', {
    params: { page, limit, search, gst }
  });
  return data;
}

export async function fetchBulkEditableProducts(search = '') {
  const { data } = await api.get('/products/bulk-edit/search', {
    params: { search }
  });
  return Array.isArray(data) ? data : [];
}

export async function saveProduct(product) {
  const { data } = await api.post('/products/save', product);
  return data;
}

export async function bulkUpdateProducts(rows) {
  const { data } = await api.post('/products/bulk-update', { rows });
  return data;
}

function downloadBlob(blob, filename) {
  const url = window.URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.URL.revokeObjectURL(url);
}

export async function exportProducts() {
  const { data } = await api.get('/products/export', { responseType: 'blob' });
  downloadBlob(data, 'badizo_products_export.csv');
}

export async function importProducts(csv) {
  const { data } = await api.post('/products/import', { csv });
  return data;
}

export async function fetchBarcodeTemplate(templateName = 'tsc-244-pro-50x50-two-up.prn') {
  const { data } = await api.get('/barcode/template', {
    params: { template: templateName }
  });
  return data;
}

export async function generateBarcodePrn(payload) {
  const { data } = await api.post('/barcode/prn', payload);
  return data;
}

export async function fetchDashboardReport() {
  const { data } = await api.get('/reports/dashboard');
  return data;
}

export async function fetchDailySalesReport({ date, from, to, counter = '' } = {}) {
  const { data } = await api.get('/reports/daily-sales', {
    params: { date, from, to, counter }
  });
  return data;
}

export async function exportDailySalesReport({ date, from, to, counter = '' } = {}) {
  const { data } = await api.get('/reports/daily-sales/export', {
    params: { date, from, to, counter },
    responseType: 'blob'
  });
  const rangeLabel = from && to ? `${from}_to_${to}` : date || 'today';
  downloadBlob(data, `badizo_daily_sales_${rangeLabel}.csv`);
}

export async function fetchGstHsnReport({ from, to } = {}) {
  const { data } = await api.get('/reports/gst-hsn', {
    params: { from, to }
  });
  return data;
}

export async function fetchMonthlySalesReport(month) {
  const { data } = await api.get('/reports/monthly-sales', { params: { month } });
  return data;
}

export async function fetchStockReport(lowOnly = false) {
  const { data } = await api.get('/reports/stock', { params: { low_only: lowOnly ? '1' : '' } });
  return Array.isArray(data) ? data : [];
}

export async function fetchTopProductsReport({ from, to, direction = 'DESC' } = {}) {
  const { data } = await api.get('/reports/top-products', { params: { from, to, direction } });
  return data;
}

export async function fetchTaxSummaryReport({ from, to } = {}) {
  const { data } = await api.get('/reports/tax-summary', { params: { from, to } });
  return data;
}

export async function fetchGstr1Report({ from, to } = {}) {
  const { data } = await api.get('/reports/gstr1', { params: { from, to } });
  return data;
}

export async function fetchCounterHandoverReport({ from, to, counter = '' } = {}) {
  const { data } = await api.get('/reports/counter-handover', { params: { from, to, counter } });
  return data;
}

export async function fetchExceptionReport({ from, to } = {}) {
  const { data } = await api.get('/reports/exceptions', { params: { from, to } });
  return data;
}

export async function checkout(payload) {
  const { data } = await api.post('/billing/checkout', payload);
  return data;
}

export async function fetchNextInvoice(counterNo = 1) {
  const { data } = await api.get('/billing/invoice/next', {
    params: { counter_no: counterNo }
  });
  return data;
}

export async function fetchSettings() {
  const { data } = await api.get('/settings');
  return data;
}

export async function saveSettings(settings) {
  const { data } = await api.post('/settings', settings);
  return data;
}

export async function fetchBackups() {
  const { data } = await api.get('/backup');
  return data;
}

export async function runBackup() {
  const { data } = await api.post('/backup/run');
  return data;
}

export async function downloadBackup(file) {
  const { data } = await api.get(`/backup/download/${encodeURIComponent(file)}`, {
    responseType: 'blob'
  });
  downloadBlob(data, file);
}

export async function restoreBackup(file, confirmation) {
  const { data } = await api.post('/backup/restore', { file, confirmation });
  return data;
}

export async function fetchInvoiceHistory() {
  const { data } = await api.get('/billing/hold/list');
  return Array.isArray(data) ? data : [];
}

export async function fetchInvoiceDetails(invoiceNo) {
  const { data } = await api.get('/billing/invoice/details', {
    params: { invoice_no: invoiceNo }
  });
  return data;
}

export async function recordInvoiceReprint(invoiceNo) {
  const { data } = await api.post('/billing/invoice/reprint', { invoice_no: invoiceNo });
  return data;
}

export async function voidInvoice(invoiceNo, reason) {
  const { data } = await api.post('/billing/invoice/void', { invoice_no: invoiceNo, reason });
  return data;
}

export async function createSalesReturn(payload) {
  const { data } = await api.post('/billing/return', payload);
  return data;
}

export async function holdBill(holdToken, savedState, metadata = {}) {
  const { data } = await api.post('/billing/hold', {
    hold_token: holdToken,
    saved_state: savedState,
    ...metadata
  });
  return data;
}

export async function fetchHeldBills(counterNo) {
  const { data } = await api.get('/billing/holds', {
    params: counterNo ? { counter_no: counterNo } : {}
  });
  return Array.isArray(data) ? data : [];
}

export async function deleteHeldBill(holdToken) {
  const { data } = await api.delete(`/billing/hold/${encodeURIComponent(holdToken)}`);
  return data;
}

export async function fetchRecentInwards() {
  const { data } = await api.get('/inward/recent');
  return Array.isArray(data) ? data : [];
}

export async function fetchInwardHistory({ from = '', to = '', supplier = '', invoice = '' } = {}) {
  const { data } = await api.get('/inward/history', {
    params: { from, to, supplier, invoice }
  });
  return Array.isArray(data) ? data : [];
}

export async function fetchInwardDetails(id) {
  const { data } = await api.get(`/inward/${encodeURIComponent(id)}/details`);
  return data;
}

export async function fetchInwardDetailsByNumber(inwardNo) {
  const { data } = await api.get(`/inward/by-number/${encodeURIComponent(inwardNo)}/details`);
  return data;
}

export async function saveInwardEntry(payload) {
  const { data } = await api.post('/inward', payload);
  return data;
}

export async function lookupCustomer(phone) {
  const { data } = await api.get(`/customers/lookup/${encodeURIComponent(phone)}`);
  return data;
}

export async function saveCustomer(customer) {
  const { data } = await api.post('/customers', customer);
  return data;
}

export async function fetchCustomers(search = '') {
  const { data } = await api.get('/customers', { params: { search } });
  return Array.isArray(data) ? data : [];
}

export async function fetchBooksSummary(dateOrRange) {
  const params = typeof dateOrRange === 'object' ? dateOrRange : { date: dateOrRange };
  const { data } = await api.get('/books/summary', { params });
  return data;
}

export async function fetchDayBook(dateOrRange) {
  const params = typeof dateOrRange === 'object' ? dateOrRange : { date: dateOrRange };
  const { data } = await api.get('/books/day-book', { params });
  return data;
}

export async function fetchAccountingBooks(dateOrRange) {
  const params = typeof dateOrRange === 'object' ? dateOrRange : { date: dateOrRange };
  const { data } = await api.get('/books/accounting', { params });
  return data;
}

export async function saveAccountingVoucher(payload) {
  const { data } = await api.post('/accounting-vouchers', payload);
  return data;
}

export async function fetchCounterExpected(date, counterNo) {
  const { data } = await api.get('/counter-closing/expected', {
    params: { date, counter_no: counterNo }
  });
  return data;
}

export async function saveCounterClosing(payload) {
  const { data } = await api.post('/counter-closing', payload);
  return data;
}

export async function fetchCounterClosingSummary(date) {
  const { data } = await api.get('/counter-closing/summary', { params: { date } });
  return data;
}

export async function fetchCounterHandover(date, counterNo) {
  const { data } = await api.get('/counter-closing/handover', {
    params: { date, counter_no: counterNo }
  });
  return data;
}

export async function saveCounterHandover(payload) {
  const { data } = await api.post('/counter-closing/handover', payload);
  return data;
}

export async function fetchCounterHandoverHistory({ from, to, counterNo = '' } = {}) {
  const { data } = await api.get('/counter-closing/handover/history', {
    params: { from, to, counter_no: counterNo }
  });
  return data;
}

export async function fetchUsers() {
  const { data } = await api.get('/users');
  return Array.isArray(data) ? data : [];
}

export async function saveUser(user) {
  const { data } = await api.post('/users', user);
  return data;
}

export async function fetchAuditLogs(limit = 100) {
  const { data } = await api.get('/audit', { params: { limit } });
  return Array.isArray(data) ? data : [];
}

export default api;
