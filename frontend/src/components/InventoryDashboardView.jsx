import React, { useEffect, useRef, useState } from 'react';
import * as XLSX from 'xlsx';
import {
  bulkUpdateProducts,
  fetchBulkEditableProducts,
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
  gst_percent: '',
  unit_type: '',
  mrp: '',
  purchase_price: '',
  sale_price: '',
  wholesale_price: '',
  discount_type: 'VALUE',
  discount_value: '',
  bulk_discount_value: '',
  is_free_item: false,
  stock_qty: '100',
  min_stock_alert: '10',
  created_at: '',
  updated_at: ''
};

const GST_OPTIONS = ['0', '3', '5', '12', '18', '28', '40'];
const UNIT_OPTIONS = ['Nos', 'Gm', 'Kg', 'Ml', 'Ltr', 'Pack'];
const PRODUCT_EXCEL_HEADERS = [
  'Sno',
  'Product Code',
  'Description',
  'HSN',
  'MRP',
  'Sale GST %',
  'Unit',
  'Purchase Price',
  'Discount',
  'Sale Net Price',
  'Wholesale Price',
  'Opening Stock',
  'Low Stock Alert'
];

const PRODUCT_EXCEL_SAMPLE_ROWS = [
  ['1', '89100100', 'KCP SUGAR', '123456', '80.00', '5', '1.KG', '60.00', '10.00', '70.00', '68.00', '100', '10'],
  ['2', '89102256', 'NAYASA BUCKET', '2515', '500.00', '18', '1', '400.00', '100.00', '300.00', '285.00', '25', '5'],
  ['3', '8100123', 'ONION', '44155', '', '0', '1.KG', '25.00', '', '30.00', '28.00', '50', '10'],
  ['4', '892456', 'THUMS UP 2.LT BOTTLE', '51456', '100.00', '40', '1', '80.00', '10.00', '90.00', '87.00', '20', '5']
];

const PRODUCT_API_IMPORT_HEADERS = [
  'product_code',
  'barcode',
  'product_name',
  'hsn_code',
  'gst_percent',
  'unit_type',
  'mrp',
  'purchase_price',
  'sale_price',
  'wholesale_price',
  'discount_type',
  'discount_value',
  'bulk_discount_value',
  'is_free_item',
  'stock_qty',
  'min_stock_alert'
];

function csvCell(value) {
  const text = String(value ?? '');
  if (/[",\n\r]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

function uppercaseProductName(value) {
  return String(value || '').replace(/\s+/g, ' ').trim().toUpperCase();
}

function formatProductDate(value) {
  if (!value) return '-';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '-';
  return date.toLocaleString('en-IN', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  });
}

function todayIso() {
  return new Date().toISOString();
}

function moneyInput(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return '';
  return Math.max(number, 0).toFixed(2);
}

function calculateDiscountFromPrice(mrpValue, priceValue, discountType) {
  const mrp = Number(mrpValue);
  const price = Number(priceValue);
  if (!Number.isFinite(mrp) || mrp <= 0 || !Number.isFinite(price)) return '';
  const discountAmount = Math.max(mrp - price, 0);
  if (discountType === 'PERCENT') return moneyInput((discountAmount / mrp) * 100);
  return moneyInput(discountAmount);
}

function calculatePriceFromDiscount(mrpValue, discountValue, discountType) {
  const mrp = Number(mrpValue);
  const discount = Number(discountValue);
  if (!Number.isFinite(mrp) || mrp < 0 || !Number.isFinite(discount)) return '';
  if (discountType === 'PERCENT') return moneyInput(mrp - (mrp * discount) / 100);
  return moneyInput(mrp - discount);
}

function tableHtmlToCsv(text) {
  const parser = new DOMParser();
  const document = parser.parseFromString(text, 'text/html');
  const rows = Array.from(document.querySelectorAll('tr'));
  if (!rows.length) return text;

  return rows.map((row) => (
    Array.from(row.querySelectorAll('th,td'))
      .map((cell) => csvCell(cell.textContent.trim()))
      .join(',')
  )).join('\n');
}

function normalizeProductImportFile(text) {
  const trimmed = String(text || '').trim();
  if (/^<!doctype html/i.test(trimmed) || /<table[\s>]/i.test(trimmed)) {
    return tableHtmlToCsv(trimmed);
  }
  if (!trimmed.includes(',') && trimmed.includes('\t')) {
    return trimmed.split(/\r?\n/).map((line) => line.split('\t').map(csvCell).join(',')).join('\n');
  }
  return text;
}

function normalizeHeaderName(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[().:%]/g, '')
    .replace(/[_/-]+/g, ' ')
    .replace(/\s+/g, ' ');
}

function rowsToApiImportCsv(rows) {
  if (!rows.length) return '';

  const headers = rows[0].map(normalizeHeaderName);
  const columnIndex = (aliases) => headers.findIndex((header) => aliases.map(normalizeHeaderName).includes(header));
  const indexes = {
    productCode: columnIndex(['Product Code', 'product_code', 'item code', 'code']),
    barcode: columnIndex(['Barcode', 'bar code', 'ean']),
    productName: columnIndex(['Description', 'Product Name', 'product_name', 'item name', 'product']),
    hsn: columnIndex(['HSN', 'HSN Code', 'hsn_code', 'HSN/SAC']),
    mrp: columnIndex(['MRP']),
    gst: columnIndex(['Sale GST %', 'GST %', 'gst_percent', 'GST']),
    unit: columnIndex(['Unit', 'Unit Type', 'unit_type', 'UOM']),
    purchasePrice: columnIndex(['Purchase Price', 'purchase_price', 'purchase rate', 'cost price', 'cost']),
    wholesalePrice: columnIndex(['Wholesale Price', 'wholesale_price', 'wholesale rate']),
    discount: columnIndex(['Discount', 'discount_value', 'disc']),
    salePrice: columnIndex(['Sale Net Price', 'sale_price', 'sale price', 'retail price']),
    stock: columnIndex(['Opening Stock', 'stock_qty', 'stock']),
    lowStock: columnIndex(['Low Stock Alert', 'min_stock_alert', 'minimum stock'])
  };

  const valueAt = (row, index) => (index >= 0 ? String(row[index] ?? '').trim() : '');
  const apiRows = rows.slice(1)
    .filter((row) => {
      const productCode = valueAt(row, indexes.productCode);
      const barcode = valueAt(row, indexes.barcode);
      const productName = valueAt(row, indexes.productName);
      return Boolean(productCode || barcode || productName);
    })
    .map((row) => {
      const productCode = valueAt(row, indexes.productCode);
      const barcode = valueAt(row, indexes.barcode) || productCode;
      const discount = valueAt(row, indexes.discount);
      return {
        product_code: productCode,
        barcode,
        product_name: uppercaseProductName(valueAt(row, indexes.productName)),
        hsn_code: valueAt(row, indexes.hsn),
        gst_percent: valueAt(row, indexes.gst) || '0',
        unit_type: valueAt(row, indexes.unit) || 'Nos',
        mrp: valueAt(row, indexes.mrp),
        purchase_price: valueAt(row, indexes.purchasePrice),
        sale_price: valueAt(row, indexes.salePrice),
        wholesale_price: valueAt(row, indexes.wholesalePrice) || valueAt(row, indexes.salePrice),
        discount_type: discount ? 'VALUE' : 'PERCENT',
        discount_value: discount || '0',
        bulk_discount_value: '0',
        is_free_item: '0',
        stock_qty: valueAt(row, indexes.stock) || '0',
        min_stock_alert: valueAt(row, indexes.lowStock) || '10'
      };
    });

  return [
    PRODUCT_API_IMPORT_HEADERS.map(csvCell).join(','),
    ...apiRows.map((row) => PRODUCT_API_IMPORT_HEADERS.map((header) => csvCell(row[header])).join(','))
  ].join('\n');
}

function downloadProductExcelTemplate() {
  const rows = [
    PRODUCT_EXCEL_HEADERS,
    ...PRODUCT_EXCEL_SAMPLE_ROWS
  ];
  const worksheet = XLSX.utils.aoa_to_sheet(rows);
  worksheet['!cols'] = [
    { wch: 6 },
    { wch: 16 },
    { wch: 30 },
    { wch: 12 },
    { wch: 10 },
    { wch: 12 },
    { wch: 10 },
    { wch: 15 },
    { wch: 12 },
    { wch: 15 },
    { wch: 15 },
    { wch: 15 },
    { wch: 16 }
  ];
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, 'Products');
  XLSX.writeFile(workbook, 'badizo_product_import_sample.xlsx');
}

async function readProductImportFile(file) {
  const extension = file.name.split('.').pop()?.toLowerCase();
  if (['xlsx', 'xls'].includes(extension)) {
    const buffer = await file.arrayBuffer();
    const workbook = XLSX.read(buffer, { type: 'array' });
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });
    return rowsToApiImportCsv(rows);
  }

  const normalizedText = normalizeProductImportFile(await file.text());
  const workbook = XLSX.read(normalizedText, { type: 'string' });
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  const rows = sheet ? XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' }) : [];
  return rows.length ? rowsToApiImportCsv(rows) : normalizedText;
}

export default function InventoryDashboardView() {
  const [products, setProducts] = useState([]);
  const [form, setForm] = useState({ ...emptyForm, created_at: todayIso() });
  const [filter, setFilter] = useState('');
  const [gstFilter, setGstFilter] = useState('ALL');
  const [page, setPage] = useState(1);
  const [limit, setLimit] = useState(50);
  const [pagination, setPagination] = useState({ total: 0, totalPages: 1 });
  const [summary, setSummary] = useState({ totalSku: 0, lowStock: 0, inventoryValue: 0 });
  const [isLoading, setIsLoading] = useState(false);
  const [importSummary, setImportSummary] = useState(null);
  const [bulkSearch, setBulkSearch] = useState('');
  const [bulkRows, setBulkRows] = useState([]);
  const [bulkPatch, setBulkPatch] = useState({ hsn_code: '', gst_percent: '', unit_type: '' });
  const [isBulkLoading, setIsBulkLoading] = useState(false);
  const [isBulkSaving, setIsBulkSaving] = useState(false);
  const [statusMessage, setStatusMessage] = useState('');
  const [errorMessage, setErrorMessage] = useState('');
  const currentUser = getStoredUser();
  const canManageProducts = ['SERVER', 'ADMIN'].includes(currentUser?.role);
  const productCodeRef = useRef(null);
  const barcodeRef = useRef(null);
  const productNameRef = useRef(null);
  const hsnRef = useRef(null);
  const gstRef = useRef(null);
  const unitRef = useRef(null);
  const mrpRef = useRef(null);
  const purchasePriceRef = useRef(null);
  const salePriceRef = useRef(null);
  const wholesalePriceRef = useRef(null);
  const discountTypeRef = useRef(null);
  const discountRef = useRef(null);
  const wholesaleDiscountRef = useRef(null);
  const stockRef = useRef(null);
  const lowStockRef = useRef(null);
  const saveButtonRef = useRef(null);

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

  function focusProductField(ref) {
    window.setTimeout(() => {
      ref.current?.focus();
      ref.current?.select?.();
    }, 0);
  }

  function moveOnEnter(event, nextRef) {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    focusProductField(nextRef);
  }

  function resetProductForm() {
    setForm({ ...emptyForm, created_at: todayIso(), updated_at: '' });
    focusProductField(productCodeRef);
  }

  function updateField(field, value) {
    setForm((current) => {
      const next = { ...current, [field]: field === 'product_name' ? value.toUpperCase() : value };
      const discountType = field === 'discount_type' ? value : next.discount_type;

      if (field === 'mrp') {
        if (next.sale_price !== '') next.discount_value = calculateDiscountFromPrice(value, next.sale_price, discountType);
        if (next.wholesale_price !== '') next.bulk_discount_value = calculateDiscountFromPrice(value, next.wholesale_price, discountType);
      }

      if (field === 'sale_price') {
        next.discount_value = calculateDiscountFromPrice(next.mrp, value, discountType);
        if (next.wholesale_price === '') {
          next.wholesale_price = value;
          next.bulk_discount_value = next.discount_value;
        }
      }

      if (field === 'discount_value') {
        next.sale_price = calculatePriceFromDiscount(next.mrp, value, discountType);
        if (next.wholesale_price === '') next.wholesale_price = next.sale_price;
      }

      if (field === 'wholesale_price') {
        next.bulk_discount_value = calculateDiscountFromPrice(next.mrp, value, discountType);
      }

      if (field === 'bulk_discount_value') {
        next.wholesale_price = calculatePriceFromDiscount(next.mrp, value, discountType);
      }

      if (field === 'discount_type') {
        if (next.sale_price !== '') next.discount_value = calculateDiscountFromPrice(next.mrp, next.sale_price, value);
        if (next.wholesale_price !== '') next.bulk_discount_value = calculateDiscountFromPrice(next.mrp, next.wholesale_price, value);
      }

      return next;
    });
  }

  function validateProductForm() {
    const requiredFields = [
      ...(form.code_mode === 'MANUAL' ? [['product_code', 'Product Code']] : []),
      ['barcode', 'Barcode'],
      ['product_name', 'Product name'],
      ['hsn_code', 'HSN code'],
      ['gst_percent', 'GST percent'],
      ['unit_type', 'Unit'],
      ['mrp', 'MRP'],
      ['purchase_price', 'Purchase price'],
      ['sale_price', 'Retail sale price'],
      ['wholesale_price', 'Wholesale price'],
      ['discount_value', 'Discount'],
      ['bulk_discount_value', 'Wholesale discount'],
      ['stock_qty', 'Current stock'],
      ['min_stock_alert', 'Low stock alert']
    ];
    const missing = requiredFields
      .filter(([field]) => String(form[field] ?? '').trim() === '')
      .map(([, label]) => label);

    if (missing.length) return `Fill all product columns before saving. Missing: ${missing.join(', ')}.`;

    const mrp = toNumber(form.mrp);
    const salePrice = toNumber(form.sale_price);
    const wholesalePrice = toNumber(form.wholesale_price);
    const purchasePrice = toNumber(form.purchase_price);

    if (salePrice > mrp && mrp > 0) return 'Retail sale price cannot be greater than MRP.';
    if (wholesalePrice > mrp && mrp > 0) return 'Wholesale price cannot be greater than MRP.';
    if (purchasePrice < 0) return 'Purchase price cannot be negative.';
    return '';
  }

  function editProduct(product) {
    setForm({
      product_code: product.product_code || '',
      code_mode: product.product_code ? 'MANUAL' : 'AUTO',
      barcode: product.barcode || '',
      product_name: product.product_name || '',
      hsn_code: product.hsn_code || '',
      gst_percent: String(product.gst_percent ?? '18'),
      unit_type: product.unit_type || 'Nos',
      mrp: String(product.mrp ?? ''),
      purchase_price: String(product.purchase_price ?? ''),
      sale_price: String(product.sale_price ?? ''),
      wholesale_price: String(product.wholesale_price ?? ''),
      discount_type: product.discount_type || 'PERCENT',
      discount_value: String(product.discount_value ?? ''),
      bulk_discount_value: String(product.bulk_discount_value ?? ''),
      is_free_item: Boolean(product.is_free_item),
      stock_qty: String(product.stock_qty ?? '0'),
      min_stock_alert: String(product.min_stock_alert ?? '10'),
      created_at: product.created_at || product.updated_at || todayIso(),
      updated_at: product.updated_at || ''
    });
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  async function handleSubmit(event) {
    event.preventDefault();
    setStatusMessage('');
    setErrorMessage('');

    const validationError = validateProductForm();
    if (validationError) {
      setErrorMessage(validationError);
      return;
    }

    try {
      await saveProduct({
        ...form,
        barcode: form.barcode.trim(),
        product_name: uppercaseProductName(form.product_name)
      });
      setStatusMessage(`${form.product_name} saved.`);
      resetProductForm();
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
      const csv = await readProductImportFile(file);
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

  async function searchBulkProducts() {
    const cleaned = bulkSearch.trim();
    setStatusMessage('');
    setErrorMessage('');

    if (cleaned.length < 3) {
      setErrorMessage('Enter at least 3 letters or two words to search products for bulk edit.');
      return;
    }

    setIsBulkLoading(true);
    try {
      const rows = await fetchBulkEditableProducts(cleaned);
      setBulkRows(rows.map((row) => ({
        ...row,
        gst_percent: String(row.gst_percent ?? '0'),
        unit_type: row.unit_type || 'Nos'
      })));
      setStatusMessage(`${rows.length} products loaded for bulk edit.`);
    } catch (err) {
      setErrorMessage(err.response?.data?.error || 'Unable to load products for bulk edit.');
    } finally {
      setIsBulkLoading(false);
    }
  }

  function updateBulkRow(index, field, value) {
    setBulkRows((current) => current.map((row, rowIndex) => (
      rowIndex === index ? { ...row, [field]: value } : row
    )));
  }

  function applyBulkPatch() {
    setBulkRows((current) => current.map((row) => ({
      ...row,
      ...(bulkPatch.hsn_code.trim() ? { hsn_code: bulkPatch.hsn_code.trim() } : {}),
      ...(bulkPatch.gst_percent ? { gst_percent: bulkPatch.gst_percent } : {}),
      ...(bulkPatch.unit_type ? { unit_type: bulkPatch.unit_type } : {})
    })));
  }

  async function saveBulkRows() {
    setStatusMessage('');
    setErrorMessage('');

    if (!bulkRows.length) {
      setErrorMessage('Search and load products before saving bulk edit.');
      return;
    }

    const confirmed = window.confirm(`Save changes for ${bulkRows.length} products? Barcode will not be changed.`);
    if (!confirmed) return;

    setIsBulkSaving(true);
    try {
      const result = await bulkUpdateProducts(bulkRows);
      setStatusMessage(`${result.updated} products updated.`);
      await loadProducts(1);
      setPage(1);
    } catch (err) {
      setErrorMessage(err.response?.data?.error || 'Unable to save bulk product edit.');
    } finally {
      setIsBulkSaving(false);
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
          <div className="product-date-strip">
            <span>Product Created Date: <strong>{formatProductDate(form.created_at || form.updated_at)}</strong></span>
            <span>Product Edit Date: <strong>{formatProductDate(form.updated_at || form.created_at)}</strong></span>
          </div>

          <div className="segmented two">
            <button type="button" className={form.code_mode === 'AUTO' ? 'active' : ''} onClick={() => updateField('code_mode', 'AUTO')}>Auto Code</button>
            <button type="button" className={form.code_mode === 'MANUAL' ? 'active' : ''} onClick={() => updateField('code_mode', 'MANUAL')}>Manual Code</button>
          </div>

          <label>
            <span className="field-label">Product Code</span>
            <input
              ref={productCodeRef}
              className="field"
              value={form.product_code}
              onChange={(event) => updateField('product_code', event.target.value.toUpperCase())}
              onKeyDown={(event) => moveOnEnter(event, barcodeRef)}
              placeholder={form.code_mode === 'AUTO' ? 'Auto generated when empty' : 'Enter product code'}
              required={form.code_mode === 'MANUAL'}
            />
          </label>

          <label>
            <span className="field-label">Barcode 128 (0-9, A-Z)</span>
            <input ref={barcodeRef} className="field" value={form.barcode} onChange={(event) => updateField('barcode', event.target.value.toUpperCase())} onKeyDown={(event) => moveOnEnter(event, productNameRef)} required />
          </label>

          <label>
            <span className="field-label">Product name</span>
            <input ref={productNameRef} className="field" value={form.product_name} onChange={(event) => updateField('product_name', event.target.value)} onKeyDown={(event) => moveOnEnter(event, hsnRef)} required />
          </label>

          <label>
            <span className="field-label">HSN code</span>
            <input ref={hsnRef} className="field" value={form.hsn_code} onChange={(event) => updateField('hsn_code', event.target.value)} onKeyDown={(event) => moveOnEnter(event, gstRef)} required />
          </label>

          <label>
            <span className="field-label">GST percent</span>
            <select ref={gstRef} className="select" value={form.gst_percent} onChange={(event) => updateField('gst_percent', event.target.value)} onKeyDown={(event) => moveOnEnter(event, unitRef)}>
              <option value="">Select GST</option>
              {GST_OPTIONS.map((gst) => <option key={gst} value={gst}>{gst}%</option>)}
            </select>
          </label>

          <label>
            <span className="field-label">Unit / Nos</span>
            <select ref={unitRef} className="select" value={form.unit_type} onChange={(event) => updateField('unit_type', event.target.value)} onKeyDown={(event) => moveOnEnter(event, mrpRef)}>
              <option value="">Select Unit</option>
              {UNIT_OPTIONS.map((unit) => <option key={unit} value={unit}>{unit}</option>)}
            </select>
          </label>

          <label>
            <span className="field-label">MRP</span>
            <input ref={mrpRef} className="field" type="number" step="0.01" min="0" value={form.mrp} onChange={(event) => updateField('mrp', event.target.value)} onKeyDown={(event) => moveOnEnter(event, purchasePriceRef)} required />
          </label>

          <label>
            <span className="field-label">Purchase price / Cost</span>
            <input ref={purchasePriceRef} className="field" type="number" step="0.01" min="0" value={form.purchase_price} onChange={(event) => updateField('purchase_price', event.target.value)} onKeyDown={(event) => moveOnEnter(event, salePriceRef)} placeholder="Cost to store" required />
          </label>

          <label>
            <span className="field-label">Retail sale price</span>
            <input ref={salePriceRef} className="field" type="number" step="0.01" min="0" value={form.sale_price} onChange={(event) => updateField('sale_price', event.target.value)} onKeyDown={(event) => moveOnEnter(event, wholesalePriceRef)} required />
          </label>

          <label>
            <span className="field-label">Wholesale price</span>
            <input ref={wholesalePriceRef} className="field" type="number" step="0.01" min="0" value={form.wholesale_price} onChange={(event) => updateField('wholesale_price', event.target.value)} onKeyDown={(event) => moveOnEnter(event, discountTypeRef)} placeholder="Defaults to retail price" required />
          </label>

          <label>
            <span className="field-label">Discount Type</span>
            <select ref={discountTypeRef} className="select" value={form.discount_type} onChange={(event) => updateField('discount_type', event.target.value)} onKeyDown={(event) => moveOnEnter(event, discountRef)}>
              <option value="PERCENT">Percent</option>
              <option value="VALUE">Value</option>
            </select>
          </label>

          <label>
            <span className="field-label">Discount</span>
            <input ref={discountRef} className="field" type="number" step="0.01" min="0" value={form.discount_value} onChange={(event) => updateField('discount_value', event.target.value)} onKeyDown={(event) => moveOnEnter(event, wholesaleDiscountRef)} required />
          </label>

          <label>
            <span className="field-label">Wholesale Discount</span>
            <input ref={wholesaleDiscountRef} className="field" type="number" step="0.01" min="0" value={form.bulk_discount_value} onChange={(event) => updateField('bulk_discount_value', event.target.value)} onKeyDown={(event) => moveOnEnter(event, stockRef)} required />
          </label>

          <label className="change-box">
            <input type="checkbox" checked={form.is_free_item} onChange={(event) => updateField('is_free_item', event.target.checked)} /> Free product entry
          </label>

          <label>
            <span className="field-label">Current stock</span>
            <input ref={stockRef} className="field" type="number" step="0.01" min="0" value={form.stock_qty} onChange={(event) => updateField('stock_qty', event.target.value)} onKeyDown={(event) => moveOnEnter(event, lowStockRef)} required />
          </label>

          <label>
            <span className="field-label">Low stock alert</span>
            <input ref={lowStockRef} className="field" type="number" step="0.01" min="0" value={form.min_stock_alert} onChange={(event) => updateField('min_stock_alert', event.target.value)} onKeyDown={(event) => moveOnEnter(event, saveButtonRef)} required />
          </label>

          <button ref={saveButtonRef} className="primary-button" type="submit" disabled={!canManageProducts}>Save Product</button>
          <button className="secondary-button" type="button" onClick={resetProductForm}>Clear</button>
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
            <>
              <div className="import-toolbar">
                <button className="secondary-button" onClick={downloadProductExcelTemplate}>Download Sample Excel</button>
                <button className="secondary-button" onClick={exportProducts}>Export CSV</button>
                <label className="secondary-button file-button">
                  Upload Filled Excel/CSV
                  <input type="file" accept=".xlsx,.xls,.csv,.tsv,.txt,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel,text/csv,text/tab-separated-values,text/plain" onChange={handleImportFile} />
                </label>
              </div>
              <div className="change-box" style={{ marginBottom: 12 }}>
                Download the sample Excel file, fill product rows, then upload the same .xlsx file. CSV/TSV also works.
              </div>

              <section className="bulk-edit-box">
                <div className="bulk-edit-toolbar">
                  <input
                    className="field"
                    value={bulkSearch}
                    onChange={(event) => setBulkSearch(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') searchBulkProducts();
                    }}
                    placeholder="Bulk edit search: rice 500, atta 1kg, oil..."
                  />
                  <button className="secondary-button" onClick={searchBulkProducts} disabled={isBulkLoading}>
                    {isBulkLoading ? 'Searching...' : 'Search'}
                  </button>
                </div>

                {bulkRows.length > 0 && (
                  <>
                    <div className="bulk-apply-row">
                      <input
                        className="field"
                        value={bulkPatch.hsn_code}
                        onChange={(event) => setBulkPatch((current) => ({ ...current, hsn_code: event.target.value }))}
                        placeholder="Bulk HSN"
                      />
                      <select className="select" value={bulkPatch.gst_percent} onChange={(event) => setBulkPatch((current) => ({ ...current, gst_percent: event.target.value }))}>
                        <option value="">Bulk GST</option>
                        {GST_OPTIONS.map((gst) => <option key={gst} value={gst}>{gst}%</option>)}
                      </select>
                      <select className="select" value={bulkPatch.unit_type} onChange={(event) => setBulkPatch((current) => ({ ...current, unit_type: event.target.value }))}>
                        <option value="">Bulk Unit</option>
                        {UNIT_OPTIONS.map((unit) => <option key={unit} value={unit}>{unit}</option>)}
                      </select>
                      <button className="secondary-button" onClick={applyBulkPatch}>Apply To Table</button>
                      <button className="primary-button compact-primary" onClick={saveBulkRows} disabled={isBulkSaving}>
                        {isBulkSaving ? 'Saving...' : 'Save Bulk Edit'}
                      </button>
                    </div>

                    <div className="bulk-table-wrap">
                      <table className="history-table">
                        <thead>
                          <tr><th>S.No</th><th>Barcode</th><th>Product Name</th><th>HSN</th><th>GST %</th><th>Units / Nos</th></tr>
                        </thead>
                        <tbody>
                          {bulkRows.map((row, index) => (
                            <tr key={row.barcode}>
                              <td>{index + 1}</td>
                              <td className="mono muted">{row.barcode}</td>
                              <td>
                                <input
                                  className="field"
                                  value={row.product_name}
                                  onChange={(event) => updateBulkRow(index, 'product_name', event.target.value.toUpperCase())}
                                />
                              </td>
                              <td>
                                <input
                                  className="field"
                                  value={row.hsn_code}
                                  onChange={(event) => updateBulkRow(index, 'hsn_code', event.target.value)}
                                />
                              </td>
                              <td>
                                <select className="select" value={row.gst_percent} onChange={(event) => updateBulkRow(index, 'gst_percent', event.target.value)}>
                                  {GST_OPTIONS.map((gst) => <option key={gst} value={gst}>{gst}%</option>)}
                                </select>
                              </td>
                              <td>
                                <select className="select" value={row.unit_type} onChange={(event) => updateBulkRow(index, 'unit_type', event.target.value)}>
                                  {UNIT_OPTIONS.map((unit) => <option key={unit} value={unit}>{unit}</option>)}
                                </select>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </>
                )}
              </section>
            </>
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
              <option value="28">28%</option>
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
                  <th>Unit</th>
                  <th>MRP</th>
                  <th>Purchase</th>
                  <th>Retail</th>
                  <th>Wholesale</th>
                  <th>Disc</th>
                  <th>Stock</th>
                  <th>Entry Date</th>
                  <th>Edit Date</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {products.length === 0 ? (
                  <tr><td colSpan="14">No products found.</td></tr>
                ) : (
                  products.map((product) => {
                    const isLow = toNumber(product.stock_qty) <= toNumber(product.min_stock_alert, 10);
                    return (
                      <tr key={product.barcode}>
                        <td className="mono muted">{product.barcode}</td>
                        <td>{product.product_code || '-'}</td>
                        <td><strong>{product.product_name}</strong></td>
                        <td>{product.gst_percent}%</td>
                        <td>{product.unit_type || 'Nos'}</td>
                        <td>{formatMoney(product.mrp)}</td>
                        <td>{formatMoney(product.purchase_price)}</td>
                        <td><strong>{formatMoney(product.sale_price)}</strong></td>
                        <td>{formatMoney(product.wholesale_price)}</td>
                        <td>{product.discount_value || 0}{product.discount_type === 'VALUE' ? ' Rs' : '%'}</td>
                        <td className={isLow ? 'stock-low' : ''}>{product.stock_qty}</td>
                        <td>{formatProductDate(product.created_at || product.updated_at)}</td>
                        <td>{formatProductDate(product.updated_at || product.created_at)}</td>
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
