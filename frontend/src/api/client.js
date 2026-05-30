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

export async function saveProduct(product) {
  const { data } = await api.post('/products/save', product);
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

export async function downloadProductTemplate() {
  const { data } = await api.get('/products/export/template', { responseType: 'blob' });
  downloadBlob(data, 'badizo_product_import_template.csv');
}

export async function exportProducts() {
  const { data } = await api.get('/products/export', { responseType: 'blob' });
  downloadBlob(data, 'badizo_products_export.csv');
}

export async function importProducts(csv) {
  const { data } = await api.post('/products/import', { csv });
  return data;
}

export async function fetchDashboardReport() {
  const { data } = await api.get('/reports/dashboard');
  return data;
}

export async function fetchDailySalesReport({ date, counter = '' } = {}) {
  const { data } = await api.get('/reports/daily-sales', {
    params: { date, counter }
  });
  return data;
}

export async function exportDailySalesReport({ date, counter = '' } = {}) {
  const { data } = await api.get('/reports/daily-sales/export', {
    params: { date, counter },
    responseType: 'blob'
  });
  downloadBlob(data, `badizo_daily_sales_${date || 'today'}.csv`);
}

export async function fetchGstHsnReport({ from, to } = {}) {
  const { data } = await api.get('/reports/gst-hsn', {
    params: { from, to }
  });
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

export async function saveInwardEntry(payload) {
  const { data } = await api.post('/inward', payload);
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
