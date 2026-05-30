import React, { useEffect, useState } from 'react';
import {
  downloadProductTemplate,
  exportProducts,
  fetchProducts,
  getStoredUser,
  importProducts,
  saveProduct
} from '../api/client';
import { formatMoney, toNumber } from '../utils/money';

const emptyForm = {
  product_code: '',
  code_mode: 'AUTO',
  barcode: '',
  product_name: '',
  hsn_code: '',
  gst_percent: '18',
  mrp: '',
  sale_price: '',
  wholesale_price: '',
  discount_type: 'PERCENT',
  discount_value: '',
  bulk_discount_value: '',
  is_free_item: false,
  stock_qty: '100',
  min_stock_alert: '10'
};

export default function InventoryDashboardView() {
  const [products, setProducts] = useState([]);
  const [form, setForm] = useState(emptyForm);
  const [filter, setFilter] = useState('');
  const [gstFilter, setGstFilter] = useState('ALL');
  const [page, setPage] = useState(1);
  const [limit, setLimit] = useState(50);
  const [pagination, setPagination] = useState({ total: 0, totalPages: 1 });
  const [summary, setSummary] = useState({ totalSku: 0, lowStock: 0, inventoryValue: 0 });
  const [isLoading, setIsLoading] = useState(false);
  const [importSummary, setImportSummary] = useState(null);
  const [statusMessage, setStatusMessage] = useState('');
  const [errorMessage, setErrorMessage] = useState('');
  const currentUser = getStoredUser();
  const canManageProducts = ['SERVER', 'ADMIN'].includes(currentUser?.role);

  useEffect(() => {
    loadProducts();
  }, [page, limit, gstFilter]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setPage(1);
      loadProducts(1);
    }, 300);

    return () => window.clearTimeout(timer);
  }, [filter]);

  async function loadProducts(targetPage = page) {
    setErrorMessage('');
    setIsLoading(true);
    try {
      const result = await fetchProducts({
        page: targetPage,
        limit,
        search: filter,
        gst: gstFilter
      });
      setProducts(Array.isArray(result.rows) ? result.rows : []);
      setPagination({
        total: Number(result.total || 0),
        totalPages: Number(result.totalPages || 1)
      });
      setSummary(result.summary || { totalSku: 0, lowStock: 0, inventoryValue: 0 });
    } catch (err) {
      setErrorMessage(err.response?.data?.error || 'Unable to load inventory.');
    } finally {
      setIsLoading(false);
    }
  }

  function updateField(field, value) {
    setForm((current) => ({ ...current, [field]: value }));
  }

  function editProduct(product) {
    setForm({
      product_code: product.product_code || '',
      code_mode: product.product_code ? 'MANUAL' : 'AUTO',
      barcode: product.barcode || '',
      product_name: product.product_name || '',
      hsn_code: product.hsn_code || '',
      gst_percent: String(product.gst_percent ?? '18'),
      mrp: String(product.mrp ?? ''),
      sale_price: String(product.sale_price ?? ''),
      wholesale_price: String(product.wholesale_price ?? ''),
      discount_type: product.discount_type || 'PERCENT',
      discount_value: String(product.discount_value ?? ''),
      bulk_discount_value: String(product.bulk_discount_value ?? ''),
      is_free_item: Boolean(product.is_free_item),
      stock_qty: String(product.stock_qty ?? '0'),
      min_stock_alert: String(product.min_stock_alert ?? '10')
    });
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  async function handleSubmit(event) {
    event.preventDefault();
    setStatusMessage('');
    setErrorMessage('');

    try {
      await saveProduct({
        ...form,
        barcode: form.barcode.trim(),
        product_name: form.product_name.trim()
      });
      setStatusMessage(`${form.product_name} saved.`);
      setForm(emptyForm);
      await loadProducts();
    } catch (err) {
      setErrorMessage(err.response?.data?.error || 'Unable to save product.');
    }
  }

  async function handleImportFile(event) {
    const file = event.target.files?.[0];
    if (!file) return;

    setStatusMessage('');
    setErrorMessage('');
    setImportSummary(null);

    try {
      const csv = await file.text();
      const result = await importProducts(csv);
      setImportSummary(result.summary);
      setStatusMessage(`Import complete: ${result.summary.inserted} inserted, ${result.summary.updated} updated.`);
      await loadProducts(1);
      setPage(1);
    } catch (err) {
      const response = err.response?.data;
      setImportSummary(response?.summary ? { ...response.summary, errors: response.errors } : null);
      setErrorMessage(response?.error || 'Unable to import products.');
    } finally {
      event.target.value = '';
    }
  }

  return (
    <div className="inventory-layout">
      <section className="panel">
        <div className="panel-header">
          <h2 className="panel-title">Product Setup</h2>
        </div>
        <form className="panel-body form-stack" onSubmit={handleSubmit}>
          {errorMessage && <div className="alert-box">{errorMessage}</div>}
          {statusMessage && <div className="change-box">{statusMessage}</div>}
          {!canManageProducts && <div className="alert-box">Login as Admin or Server to save/import products.</div>}

          <div className="segmented two">
            <button type="button" className={form.code_mode === 'AUTO' ? 'active' : ''} onClick={() => updateField('code_mode', 'AUTO')}>Auto Code</button>
            <button type="button" className={form.code_mode === 'MANUAL' ? 'active' : ''} onClick={() => updateField('code_mode', 'MANUAL')}>Manual Code</button>
          </div>

          <label>
            <span className="field-label">Product Code</span>
            <input className="field" value={form.product_code} onChange={(event) => updateField('product_code', event.target.value.toUpperCase())} placeholder={form.code_mode === 'AUTO' ? 'Auto generated when empty' : 'Enter product code'} />
          </label>

          <label>
            <span className="field-label">Barcode 128 (0-9, A-Z)</span>
            <input className="field" value={form.barcode} onChange={(event) => updateField('barcode', event.target.value.toUpperCase())} required />
          </label>

          <label>
            <span className="field-label">Product name</span>
            <input className="field" value={form.product_name} onChange={(event) => updateField('product_name', event.target.value)} required />
          </label>

          <label>
            <span className="field-label">HSN code</span>
            <input className="field" value={form.hsn_code} onChange={(event) => updateField('hsn_code', event.target.value)} />
          </label>

          <label>
            <span className="field-label">GST percent</span>
            <select className="select" value={form.gst_percent} onChange={(event) => updateField('gst_percent', event.target.value)}>
              <option value="0">0%</option>
              <option value="3">3%</option>
              <option value="5">5%</option>
              <option value="12">12%</option>
              <option value="18">18%</option>
              <option value="40">40%</option>
            </select>
          </label>

          <label>
            <span className="field-label">MRP</span>
            <input className="field" type="number" step="0.01" min="0" value={form.mrp} onChange={(event) => updateField('mrp', event.target.value)} required />
          </label>

          <label>
            <span className="field-label">Retail sale price</span>
            <input className="field" type="number" step="0.01" min="0" value={form.sale_price} onChange={(event) => updateField('sale_price', event.target.value)} required />
          </label>

          <label>
            <span className="field-label">Wholesale price</span>
            <input className="field" type="number" step="0.01" min="0" value={form.wholesale_price} onChange={(event) => updateField('wholesale_price', event.target.value)} placeholder="Defaults to retail price" />
          </label>

          <label>
            <span className="field-label">Discount Type</span>
            <select className="select" value={form.discount_type} onChange={(event) => updateField('discount_type', event.target.value)}>
              <option value="PERCENT">Percent</option>
              <option value="VALUE">Value</option>
            </select>
          </label>

          <label>
            <span className="field-label">Discount</span>
            <input className="field" type="number" step="0.01" min="0" value={form.discount_value} onChange={(event) => updateField('discount_value', event.target.value)} />
          </label>

          <label>
            <span className="field-label">Bulk Discount</span>
            <input className="field" type="number" step="0.01" min="0" value={form.bulk_discount_value} onChange={(event) => updateField('bulk_discount_value', event.target.value)} />
          </label>

          <label className="change-box">
            <input type="checkbox" checked={form.is_free_item} onChange={(event) => updateField('is_free_item', event.target.checked)} /> Free product entry
          </label>

          <label>
            <span className="field-label">Current stock</span>
            <input className="field" type="number" step="0.01" min="0" value={form.stock_qty} onChange={(event) => updateField('stock_qty', event.target.value)} />
          </label>

          <label>
            <span className="field-label">Low stock alert</span>
            <input className="field" type="number" step="0.01" min="0" value={form.min_stock_alert} onChange={(event) => updateField('min_stock_alert', event.target.value)} />
          </label>

          <button className="primary-button" type="submit" disabled={!canManageProducts}>Save Product</button>
          <button className="secondary-button" type="button" onClick={() => setForm(emptyForm)}>Clear</button>
        </form>
      </section>

      <section className="panel">
        <div className="panel-header">
          <div>
            <h2 className="panel-title">Inventory</h2>
            <div className="inventory-stats">
              <span className="status-chip">{summary.totalSku} SKUs</span>
              <span className="status-chip">{summary.lowStock} low stock</span>
              <span className="status-chip">{formatMoney(summary.inventoryValue)} value</span>
              <span className="status-chip">Showing {products.length} of {pagination.total}</span>
            </div>
          </div>
          <button className="secondary-button" onClick={() => loadProducts()}>Refresh</button>
        </div>
        <div className="panel-body">
          {canManageProducts && (
            <div className="import-toolbar">
              <button className="secondary-button" onClick={downloadProductTemplate}>Download Template</button>
              <button className="secondary-button" onClick={exportProducts}>Export CSV</button>
              <label className="secondary-button file-button">
                Import CSV
                <input type="file" accept=".csv,text/csv" onChange={handleImportFile} />
              </label>
            </div>
          )}

          {importSummary && (
            <div className={importSummary.errorRows ? 'alert-box' : 'change-box'} style={{ marginBottom: 12 }}>
              Total: {importSummary.totalRows}, Valid: {importSummary.validRows ?? importSummary.totalRows}, Inserted: {importSummary.inserted ?? 0}, Updated: {importSummary.updated ?? 0}, Errors: {importSummary.errorRows ?? 0}
              {Array.isArray(importSummary.errors) && importSummary.errors.length > 0 && (
                <div style={{ marginTop: 8 }}>
                  {importSummary.errors.slice(0, 5).map((rowError) => (
                    <div key={`${rowError.row}-${rowError.barcode}`}>Row {rowError.row}: {rowError.errors.join(', ')}</div>
                  ))}
                </div>
              )}
            </div>
          )}

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 140px 120px', gap: 10, marginBottom: 12 }}>
            <input
              className="field"
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
              placeholder="Search product name, barcode, or product code"
            />
            <select className="select" value={gstFilter} onChange={(event) => { setGstFilter(event.target.value); setPage(1); }}>
              <option value="ALL">All GST</option>
              <option value="0">0%</option>
              <option value="3">3%</option>
              <option value="5">5%</option>
              <option value="12">12%</option>
              <option value="18">18%</option>
              <option value="40">40%</option>
            </select>
            <select className="select" value={limit} onChange={(event) => { setLimit(Number(event.target.value)); setPage(1); }}>
              <option value="25">25 rows</option>
              <option value="50">50 rows</option>
              <option value="100">100 rows</option>
            </select>
          </div>

          {isLoading && <div className="change-box" style={{ marginBottom: 12 }}>Loading products from database...</div>}

          <div style={{ overflowX: 'auto' }}>
            <table className="inventory-table">
              <thead>
                <tr>
                  <th>Barcode</th>
                  <th>Code</th>
                  <th>Product</th>
                  <th>GST</th>
                  <th>MRP</th>
                  <th>Retail</th>
                  <th>Wholesale</th>
                  <th>Disc</th>
                  <th>Stock</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {products.length === 0 ? (
                  <tr><td colSpan="10">No products found.</td></tr>
                ) : (
                  products.map((product) => {
                    const isLow = toNumber(product.stock_qty) <= toNumber(product.min_stock_alert, 10);
                    return (
                      <tr key={product.barcode}>
                        <td className="mono muted">{product.barcode}</td>
                        <td>{product.product_code || '-'}</td>
                        <td><strong>{product.product_name}</strong></td>
                        <td>{product.gst_percent}%</td>
                        <td>{formatMoney(product.mrp)}</td>
                        <td><strong>{formatMoney(product.sale_price)}</strong></td>
                        <td>{formatMoney(product.wholesale_price)}</td>
                        <td>{product.discount_value || 0}{product.discount_type === 'VALUE' ? ' Rs' : '%'}</td>
                        <td className={isLow ? 'stock-low' : ''}>{product.stock_qty}</td>
                        <td><button className="secondary-button" onClick={() => editProduct(product)}>Edit</button></td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>

          <div style={{ display: 'flex', justifyContent: 'flex-end', alignItems: 'center', gap: 10, marginTop: 14 }}>
            <button className="secondary-button" disabled={page <= 1} onClick={() => setPage((current) => Math.max(current - 1, 1))}>
              Prev
            </button>
            <span className="status-chip">Page {page} of {pagination.totalPages}</span>
            <button className="secondary-button" disabled={page >= pagination.totalPages} onClick={() => setPage((current) => current + 1)}>
              Next
            </button>
          </div>
        </div>
      </section>
    </div>
  );
}
