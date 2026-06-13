import React, { useEffect, useRef, useState } from 'react';
import * as XLSX from 'xlsx';
import {
  bulkDeleteDuplicateProductCodes,
  bulkDeleteProductDropbox,
  bulkUpdateProducts,
  fetchBulkEditableProducts,
  fetchDuplicateProductCodes,
  fetchProductDropbox,
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
  alias_names: '',
  hsn_code: '',
  gst_percent: '',
  unit_type: '',
  purchase_unit_type: 'Loose',
  purchase_unit_size: '1',
  mrp: '',
  purchase_price: '',
  sale_price: '',
  wholesale_price: '',
  discount_type: 'VALUE',
  discount_value: '',
  bulk_discount_value: '',
  is_free_item: false,
  free_promo_enabled: false,
  free_promo_name: '',
  free_promo_qty_per_sale: '1',
  free_promo_total_qty: '',
  stock_qty: '100',
  min_stock_alert: '10',
  created_at: '',
  updated_at: ''
};

const GST_OPTIONS = ['0', '3', '5', '12', '18', '28', '40'];
const UNIT_OPTIONS = ['Nos', 'Gm', 'Kg', 'Ml', 'Ltr', 'Pack'];
const PURCHASE_UNIT_OPTIONS = ['Loose', 'Carton', 'Bag', 'Box', 'Case', 'Bundle', 'Pack'];
const PRODUCT_DROPBOX_DAYS = 1470;
const PRODUCT_EXCEL_HEADERS = [
  'Sno',
  'Product Code',
  'Description',
  'Alias Names',
  'Free Product Name',
  'HSN Code',
  'MRP',
  'Purchase Rate',
  'Sales GST %',
  'Sales SGST %',
  'Sales CGST %',
  'Sales IGST %',
  'Unit',
  'Sales Rate'
];

const PRODUCT_EXCEL_SAMPLE_ROWS = [
  ['73137', '89300296', '(180) JUMBO ROUND KAJU', '', '', '080211', '62.00', '62.00', '0', '2.5', '2.5', '5', '50 Gms', '62.00'],
  ['73138', '89300297', '(180) JUMBO ROUND KAJU', '', '', '080211', '120.00', '120.00', '0', '2.5', '2.5', '5', '100 Gms', '120.00'],
  ['73139', '89300298', '(180) JUMBO ROUND KAJU', '', '', '080211', '235.00', '235.00', '0', '2.5', '2.5', '5', '200 Gms', '235.00'],
  ['73140', '89300299', '(180) JUMBO ROUND KAJU', '', '', '080211', '580.00', '580.00', '0', '2.5', '2.5', '5', '500 Gms', '580.00']
];

const PRODUCT_API_IMPORT_HEADERS = [
  'product_code',
  'barcode',
  'product_name',
  'alias_names',
  'free_promo_name',
  'hsn_code',
  'gst_percent',
  'sales_sgst_percent',
  'sales_cgst_percent',
  'sales_igst_percent',
  'unit_type',
  'purchase_unit_type',
  'purchase_unit_size',
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
    aliasNames: columnIndex(['Alias Names', 'alias_names', 'aliases', 'invoice names', 'supplier names']),
    freeProductName: columnIndex(['Free Product Name', 'free product name', 'free_promo_name', 'free item name']),
    hsn: columnIndex(['HSN', 'HSN Code', 'hsn_code', 'HSN/SAC']),
    mrp: columnIndex(['MRP']),
    gst: columnIndex(['Sales GST %', 'Sale GST %', 'GST %', 'gst_percent', 'GST']),
    sgst: columnIndex(['Sales SGST %', 'Sale SGST %', 'SGST %', 'sales_sgst_percent']),
    cgst: columnIndex(['Sales CGST %', 'Sale CGST %', 'CGST %', 'sales_cgst_percent']),
    igst: columnIndex(['Sales IGST %', 'Sale IGST %', 'IGST %', 'sales_igst_percent']),
    unit: columnIndex(['Unit', 'Unit Type', 'unit_type', 'UOM']),
    purchaseUnit: columnIndex(['Purchase Unit', 'purchase_unit_type', 'purchase pack', 'pack type']),
    purchaseUnitSize: columnIndex(['Stock Per Purchase Unit', 'purchase_unit_size', 'units per pack', 'qty per pack', 'pcs per carton', 'kg per bag', 'conversion']),
    purchasePrice: columnIndex(['Purchase Price', 'purchase_price', 'purchase rate', 'cost price', 'cost']),
    wholesalePrice: columnIndex(['Wholesale Price', 'wholesale_price', 'wholesale rate']),
    discount: columnIndex(['Discount', 'discount_value', 'disc']),
    salePrice: columnIndex(['Sales Rate', 'Sale Rate', 'Sale Net Price', 'sale_price', 'sale price', 'retail price']),
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
        alias_names: uppercaseProductName(valueAt(row, indexes.aliasNames)),
        free_promo_name: uppercaseProductName(valueAt(row, indexes.freeProductName)),
        hsn_code: valueAt(row, indexes.hsn),
        gst_percent: valueAt(row, indexes.gst) || '0',
        sales_sgst_percent: valueAt(row, indexes.sgst) || '0',
        sales_cgst_percent: valueAt(row, indexes.cgst) || '0',
        sales_igst_percent: valueAt(row, indexes.igst) || '0',
        unit_type: valueAt(row, indexes.unit) || 'Nos',
        purchase_unit_type: valueAt(row, indexes.purchaseUnit) || 'Loose',
        purchase_unit_size: valueAt(row, indexes.purchaseUnitSize) || '1',
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
    { wch: 34 },
    { wch: 12 },
    { wch: 10 },
    { wch: 12 },
    { wch: 10 },
    { wch: 14 },
    { wch: 22 },
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

export default function InventoryDashboardView({ setActiveWorkspace } = {}) {
  const [products, setProducts] = useState([]);
  const [form, setForm] = useState({ ...emptyForm, created_at: todayIso() });
  const [filter, setFilter] = useState('');
  const [gstFilter, setGstFilter] = useState('ALL');
  const [page, setPage] = useState(1);
  const [limit, setLimit] = useState(50);
  const [pagination, setPagination] = useState({ total: 0, totalPages: 1 });
  const [summary, setSummary] = useState({ totalSku: 0, lowStock: 0, inventoryValue: 0 });
  const [isLoading, setIsLoading] = useState(false);
  const [isImporting, setIsImporting] = useState(false);
  const [importSummary, setImportSummary] = useState(null);
  const [importGrowl, setImportGrowl] = useState(null);
  const [bulkSearch, setBulkSearch] = useState('');
  const [bulkRows, setBulkRows] = useState([]);
  const [bulkPatch, setBulkPatch] = useState({ hsn_code: '', gst_percent: '', unit_type: '' });
  const [isBulkLoading, setIsBulkLoading] = useState(false);
  const [isBulkSaving, setIsBulkSaving] = useState(false);
  const [isDropboxOpen, setIsDropboxOpen] = useState(false);
  const [dropboxSearch, setDropboxSearch] = useState('');
  const [dropboxRows, setDropboxRows] = useState([]);
  const [dropboxSummary, setDropboxSummary] = useState({ total: 0, stockQty: 0 });
  const [selectedDropboxBarcodes, setSelectedDropboxBarcodes] = useState([]);
  const [dropboxApproval, setDropboxApproval] = useState({ username: '', password: '' });
  const [isDropboxLoading, setIsDropboxLoading] = useState(false);
  const [isDropboxDeleting, setIsDropboxDeleting] = useState(false);
  const [isDuplicateOpen, setIsDuplicateOpen] = useState(false);
  const [duplicateSearch, setDuplicateSearch] = useState('');
  const [duplicateGroups, setDuplicateGroups] = useState([]);
  const [duplicateSummary, setDuplicateSummary] = useState({ duplicateCodes: 0, duplicateProducts: 0 });
  const [selectedDuplicateBarcodes, setSelectedDuplicateBarcodes] = useState([]);
  const [duplicateApproval, setDuplicateApproval] = useState({ username: '', password: '' });
  const [isDuplicateLoading, setIsDuplicateLoading] = useState(false);
  const [isDuplicateDeleting, setIsDuplicateDeleting] = useState(false);
  const [statusMessage, setStatusMessage] = useState('');
  const [errorMessage, setErrorMessage] = useState('');
  const currentUser = getStoredUser();
  const canManageProducts = ['SERVER', 'ADMIN'].includes(currentUser?.role);
  const productCodeRef = useRef(null);
  const barcodeRef = useRef(null);
  const productNameRef = useRef(null);
  const aliasNamesRef = useRef(null);
  const hsnRef = useRef(null);
  const gstRef = useRef(null);
  const unitRef = useRef(null);
  const purchaseUnitRef = useRef(null);
  const purchaseUnitSizeRef = useRef(null);
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
  const didMountFilterRef = useRef(false);
  const pageRef = useRef(page);

  useEffect(() => {
    pageRef.current = page;
  }, [page]);

  useEffect(() => {
    loadProducts();
  }, [page, limit, gstFilter]);

  useEffect(() => {
    if (!didMountFilterRef.current) {
      didMountFilterRef.current = true;
      return undefined;
    }

    const timer = window.setTimeout(() => {
      if (pageRef.current === 1) {
        loadProducts(1);
      } else {
        setPage(1);
      }
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
      const next = { ...current, [field]: ['product_name', 'alias_names'].includes(field) ? value.toUpperCase() : value };
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

  function normalizedProductForm(source = form) {
    return {
      ...source,
      wholesale_price: String(source.wholesale_price ?? '').trim() === '' ? source.sale_price : source.wholesale_price,
      discount_value: String(source.discount_value ?? '').trim() === '' ? '0' : source.discount_value,
      bulk_discount_value: String(source.bulk_discount_value ?? '').trim() === '' ? '0' : source.bulk_discount_value,
      free_promo_qty_per_sale: String(source.free_promo_qty_per_sale ?? '').trim() === '' ? '1' : source.free_promo_qty_per_sale,
      free_promo_total_qty: String(source.free_promo_total_qty ?? '').trim() === '' ? '0' : source.free_promo_total_qty
    };
  }

  function validateProductForm(source = form) {
    const productForm = normalizedProductForm(source);
    const requiredFields = [
      ...(productForm.code_mode === 'MANUAL' ? [['product_code', 'Product Code']] : []),
      ['barcode', 'Barcode'],
      ['product_name', 'Product name'],
      ['hsn_code', 'HSN code'],
      ['gst_percent', 'GST percent'],
      ['unit_type', 'Unit'],
      ['purchase_unit_type', 'Purchase unit'],
      ['purchase_unit_size', 'Stock per purchase unit'],
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
      .filter(([field]) => String(productForm[field] ?? '').trim() === '')
      .map(([, label]) => label);

    if (missing.length) return `Fill all product columns before saving. Missing: ${missing.join(', ')}.`;

    const mrp = toNumber(productForm.mrp);
    const salePrice = toNumber(productForm.sale_price);
    const wholesalePrice = toNumber(productForm.wholesale_price);
    const purchasePrice = toNumber(productForm.purchase_price);
    const purchaseUnitSize = toNumber(productForm.purchase_unit_size);

    if (salePrice > mrp && mrp > 0) return 'Retail sale price cannot be greater than MRP.';
    if (wholesalePrice > mrp && mrp > 0) return 'Wholesale price cannot be greater than MRP.';
    if (purchasePrice < 0) return 'Purchase price cannot be negative.';
    if (purchaseUnitSize <= 0) return 'Stock per purchase unit must be greater than zero.';
    if (productForm.free_promo_enabled && !uppercaseProductName(productForm.free_promo_name)) return 'Enter free item name for product promotion.';
    return '';
  }

  function editProduct(product) {
    setForm({
      product_code: product.product_code || '',
      code_mode: product.product_code ? 'MANUAL' : 'AUTO',
      barcode: product.barcode || '',
      product_name: product.product_name || '',
      alias_names: product.alias_names || '',
      hsn_code: product.hsn_code || '',
      gst_percent: String(product.gst_percent ?? '18'),
      unit_type: product.unit_type || 'Nos',
      purchase_unit_type: product.purchase_unit_type || 'Loose',
      purchase_unit_size: String(product.purchase_unit_size ?? '1'),
      mrp: String(product.mrp ?? ''),
      purchase_price: String(product.purchase_price ?? ''),
      sale_price: String(product.sale_price ?? ''),
      wholesale_price: String(product.wholesale_price ?? ''),
      discount_type: product.discount_type || 'PERCENT',
      discount_value: String(product.discount_value ?? ''),
      bulk_discount_value: String(product.bulk_discount_value ?? ''),
      is_free_item: Boolean(product.is_free_item),
      free_promo_enabled: Boolean(product.free_promo_enabled),
      free_promo_name: product.free_promo_name || '',
      free_promo_qty_per_sale: String(product.free_promo_qty_per_sale ?? '1'),
      free_promo_total_qty: String(product.free_promo_total_qty ?? ''),
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

    const productForm = normalizedProductForm();
    const validationError = validateProductForm(productForm);
    if (validationError) {
      setErrorMessage(validationError);
      return;
    }

    try {
      const result = await saveProduct({
        ...productForm,
        barcode: productForm.barcode.trim(),
        product_name: uppercaseProductName(productForm.product_name),
        alias_names: uppercaseProductName(productForm.alias_names),
        free_promo_name: uppercaseProductName(productForm.free_promo_name)
      });
      const syncedText = result.taxSynced > 1 ? ` HSN/GST synced for ${result.taxSynced} matching products.` : '';
      setStatusMessage(`${form.product_name} saved.${syncedText}`);
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
    setImportSummary(null);
    setImportGrowl(null);
    setIsImporting(true);

    try {
      const csv = await readProductImportFile(file);
      const result = await importProducts(csv, file.name);
      setImportSummary(result.summary);
      const syncedText = result.summary.taxSynced ? ` HSN/GST synced for ${result.summary.taxSynced} matching products.` : '';
      const batchText = result.summary.batches ? ` Imported in ${result.summary.batches} batch(es).` : '';
      const skippedText = result.summary.errorRows ? ` ${result.summary.errorRows} row(s) skipped with errors.` : '';
      const isPartial = Number(result.summary.errorRows || 0) > 0;
      const title = isPartial ? 'Product import partially completed' : 'Product import completed';
      const status = isPartial ? 'PARTIAL SUCCESS' : 'SUCCESS';
      const message = `${status}: ${result.summary.inserted} inserted, ${result.summary.updated} updated.${batchText}${skippedText}${syncedText}`;
      setStatusMessage(`Import complete: ${result.summary.inserted} inserted, ${result.summary.updated} updated.${batchText}${skippedText}${syncedText}`);
      setImportGrowl({ type: isPartial ? 'warning' : 'success', title, message });
      await loadProducts(1);
      setPage(1);
    } catch (err) {
      const response = err.response?.data;
      setImportSummary(response?.summary ? { ...response.summary, errors: response.errors } : null);
      const failedRows = Number(response?.summary?.errorRows || 0);
      const validRows = Number(response?.summary?.validRows || 0);
      const status = validRows > 0 ? 'PARTIAL SUCCESS' : 'FAILED';
      const message = response?.summary
        ? `${status}: ${validRows} valid rows, ${failedRows} failed rows. Open Import History for exact row-level reason.`
        : `${status}: ${response?.error || 'Import could not be completed.'} Open Import History for details.`;
      setImportGrowl({
        type: validRows > 0 ? 'warning' : 'danger',
        title: validRows > 0 ? 'Product import partially completed' : 'Product import failed',
        message
      });
    } finally {
      setIsImporting(false);
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
      const syncedText = result.taxSynced ? ` HSN/GST synced for ${result.taxSynced} matching products.` : '';
      setStatusMessage(`${result.updated} products updated.${syncedText}`);
      await loadProducts(1);
      setPage(1);
    } catch (err) {
      setErrorMessage(err.response?.data?.error || 'Unable to save bulk product edit.');
    } finally {
      setIsBulkSaving(false);
    }
  }

  async function loadProductDropbox() {
    setStatusMessage('');
    setErrorMessage('');
    setIsDropboxOpen(true);
    setIsDropboxLoading(true);

    try {
      const result = await fetchProductDropbox({
        search: dropboxSearch,
        ageDays: PRODUCT_DROPBOX_DAYS,
        limit: 500
      });
      const rows = Array.isArray(result.rows) ? result.rows : [];
      setDropboxRows(rows);
      setDropboxSummary(result.summary || { total: rows.length, stockQty: 0 });
      setSelectedDropboxBarcodes((current) => current.filter((barcode) => rows.some((row) => row.barcode === barcode)));
      setStatusMessage(`${rows.length} old unused products loaded in Product Dropbox.`);
    } catch (err) {
      setErrorMessage(err.response?.data?.error || 'Unable to load product dropbox.');
    } finally {
      setIsDropboxLoading(false);
    }
  }

  function toggleDropboxRow(barcode) {
    setSelectedDropboxBarcodes((current) => (
      current.includes(barcode)
        ? current.filter((item) => item !== barcode)
        : [...current, barcode]
    ));
  }

  function toggleAllDropboxRows() {
    setSelectedDropboxBarcodes((current) => (
      current.length === dropboxRows.length ? [] : dropboxRows.map((row) => row.barcode)
    ));
  }

  async function deleteSelectedDropboxProducts() {
    setStatusMessage('');
    setErrorMessage('');

    if (!selectedDropboxBarcodes.length) {
      setErrorMessage('Select products from Product Dropbox before delete.');
      return;
    }

    if (!dropboxApproval.username.trim() || !dropboxApproval.password) {
      setErrorMessage('Enter supervisor username and password for product dropbox delete.');
      return;
    }

    const confirmed = window.confirm(`Delete ${selectedDropboxBarcodes.length} old unused products permanently?`);
    if (!confirmed) return;

    setIsDropboxDeleting(true);
    try {
      const result = await bulkDeleteProductDropbox({
        barcodes: selectedDropboxBarcodes,
        username: dropboxApproval.username,
        password: dropboxApproval.password,
        ageDays: PRODUCT_DROPBOX_DAYS
      });
      setStatusMessage(`${result.deleted} product dropbox items deleted. ${result.skipped || 0} skipped.`);
      setDropboxApproval((current) => ({ ...current, password: '' }));
      setSelectedDropboxBarcodes([]);
      await loadProductDropbox();
      await loadProducts(1);
      setPage(1);
    } catch (err) {
      setErrorMessage(err.response?.data?.error || 'Unable to delete product dropbox items.');
    } finally {
      setIsDropboxDeleting(false);
    }
  }

  async function loadDuplicateCodes() {
    setStatusMessage('');
    setErrorMessage('');
    setIsDuplicateOpen(true);
    setIsDuplicateLoading(true);

    try {
      const result = await fetchDuplicateProductCodes({
        search: duplicateSearch,
        limit: 100
      });
      const groups = Array.isArray(result.groups) ? result.groups : [];
      setDuplicateGroups(groups);
      setDuplicateSummary(result.summary || { duplicateCodes: groups.length, duplicateProducts: 0 });
      const validBarcodes = new Set(groups.flatMap((group) => group.products.map((product) => product.barcode)));
      setSelectedDuplicateBarcodes((current) => current.filter((barcode) => validBarcodes.has(barcode)));
      setStatusMessage(`${groups.length} duplicate product-code group(s) loaded.`);
    } catch (err) {
      setErrorMessage(err.response?.data?.error || 'Unable to load duplicate product codes.');
    } finally {
      setIsDuplicateLoading(false);
    }
  }

  function toggleDuplicateRow(barcode) {
    setSelectedDuplicateBarcodes((current) => (
      current.includes(barcode)
        ? current.filter((item) => item !== barcode)
        : [...current, barcode]
    ));
  }

  function selectDuplicateExtras() {
    const extras = duplicateGroups.flatMap((group) => (
      group.products.slice(1).map((product) => product.barcode)
    ));
    setSelectedDuplicateBarcodes(extras);
  }

  async function deleteSelectedDuplicateProducts() {
    setStatusMessage('');
    setErrorMessage('');

    if (!selectedDuplicateBarcodes.length) {
      setErrorMessage('Select duplicate products to delete.');
      return;
    }

    if (!duplicateApproval.username.trim() || !duplicateApproval.password) {
      setErrorMessage('Enter supervisor username and password for duplicate delete.');
      return;
    }

    const confirmed = window.confirm(`Delete ${selectedDuplicateBarcodes.length} duplicate products permanently? Keep one product for every code.`);
    if (!confirmed) return;

    setIsDuplicateDeleting(true);
    try {
      const result = await bulkDeleteDuplicateProductCodes({
        barcodes: selectedDuplicateBarcodes,
        username: duplicateApproval.username,
        password: duplicateApproval.password
      });
      setStatusMessage(`${result.deleted} duplicate product-code item(s) deleted. ${result.skipped || 0} skipped.`);
      setDuplicateApproval((current) => ({ ...current, password: '' }));
      setSelectedDuplicateBarcodes([]);
      await loadDuplicateCodes();
      await loadProducts(1);
      setPage(1);
    } catch (err) {
      setErrorMessage(err.response?.data?.error || 'Unable to delete duplicate product-code items.');
    } finally {
      setIsDuplicateDeleting(false);
    }
  }

  const showProductCodeColumn = filter.trim().length > 0;
  const inventoryColSpan = showProductCodeColumn ? 15 : 14;
  const selectedDropboxRows = dropboxRows.filter((row) => selectedDropboxBarcodes.includes(row.barcode));

  return (
    <div className="inventory-layout">
      {importGrowl && (
        <div className={`growl-message ${importGrowl.type}`} role="status" aria-live="polite">
          <div>
            <strong>{importGrowl.title}</strong>
            <p>{importGrowl.message}</p>
          </div>
          <div className="growl-actions">
            <button className="secondary-button" type="button" onClick={() => setActiveWorkspace?.('importHistory')}>Import History</button>
            <button className="secondary-button" type="button" onClick={() => setImportGrowl(null)}>Close</button>
          </div>
        </div>
      )}
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
            <input ref={productNameRef} className="field" value={form.product_name} onChange={(event) => updateField('product_name', event.target.value)} onKeyDown={(event) => moveOnEnter(event, aliasNamesRef)} required />
          </label>

          <label>
            <span className="field-label">Alias / invoice names</span>
            <input
              ref={aliasNamesRef}
              className="field"
              value={form.alias_names}
              onChange={(event) => updateField('alias_names', event.target.value)}
              onKeyDown={(event) => moveOnEnter(event, hsnRef)}
              placeholder="Supplier invoice names, comma separated"
            />
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
            <span className="field-label">Selling / stock unit</span>
            <select ref={unitRef} className="select" value={form.unit_type} onChange={(event) => updateField('unit_type', event.target.value)} onKeyDown={(event) => moveOnEnter(event, purchaseUnitRef)}>
              <option value="">Select Unit</option>
              {UNIT_OPTIONS.map((unit) => <option key={unit} value={unit}>{unit}</option>)}
            </select>
          </label>

          <label>
            <span className="field-label">Purchase unit</span>
            <select ref={purchaseUnitRef} className="select" value={form.purchase_unit_type} onChange={(event) => updateField('purchase_unit_type', event.target.value)} onKeyDown={(event) => moveOnEnter(event, purchaseUnitSizeRef)}>
              {PURCHASE_UNIT_OPTIONS.map((unit) => <option key={unit} value={unit}>{unit}</option>)}
            </select>
          </label>

          <label>
            <span className="field-label">Stock per purchase unit</span>
            <input
              ref={purchaseUnitSizeRef}
              className="field"
              type="number"
              step="0.001"
              min="0.001"
              value={form.purchase_unit_size}
              onChange={(event) => updateField('purchase_unit_size', event.target.value)}
              onKeyDown={(event) => moveOnEnter(event, mrpRef)}
              placeholder="Carton 72 Nos / Bag 50 Kg"
              required
            />
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

          <label className="change-box">
            <input type="checkbox" checked={form.free_promo_enabled} onChange={(event) => updateField('free_promo_enabled', event.target.checked)} /> Free promotion on this product
          </label>

          {form.free_promo_enabled && (
            <>
              <label>
                <span className="field-label">Free item name on bill</span>
                <input className="field" value={form.free_promo_name} onChange={(event) => updateField('free_promo_name', event.target.value.toUpperCase())} placeholder="CRICKET BALL FREE" />
              </label>
              <label>
                <span className="field-label">Free qty per sale qty</span>
                <input className="field" type="number" step="0.001" min="0.001" value={form.free_promo_qty_per_sale} onChange={(event) => updateField('free_promo_qty_per_sale', event.target.value)} />
              </label>
              <label>
                <span className="field-label">Total promo count</span>
                <input className="field" type="number" step="0.01" min="0" value={form.free_promo_total_qty} onChange={(event) => updateField('free_promo_total_qty', event.target.value)} placeholder="0 or blank = no limit" />
              </label>
            </>
          )}

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
              <span className="status-chip">Total SKUs {summary.totalSku}</span>
              <span className="status-chip">{summary.lowStock} low stock</span>
              <span className="status-chip">{formatMoney(summary.inventoryValue)} value</span>
              <span className="status-chip">Showing {products.length} of {pagination.total}</span>
            </div>
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button className="secondary-button" type="button" onClick={() => setActiveWorkspace?.('importHistory')}>Import History</button>
            <button className="secondary-button" onClick={() => loadProducts()}>Refresh</button>
          </div>
        </div>
        <div className="panel-body">
          {canManageProducts && (
            <>
              <div className="import-toolbar">
                <button className="secondary-button" onClick={downloadProductExcelTemplate}>Download Sample Excel</button>
                <button className="secondary-button" onClick={exportProducts}>Export CSV</button>
                <label className="secondary-button file-button">
                  {isImporting ? 'Uploading...' : 'Upload Filled Excel/CSV'}
                  <input type="file" accept=".xlsx,.xls,.csv,.tsv,.txt,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel,text/csv,text/tab-separated-values,text/plain" onChange={handleImportFile} disabled={isImporting} />
                </label>
              </div>
              <div className="change-box" style={{ marginBottom: 12 }}>
                Download the sample Excel file, fill product rows, then upload the same .xlsx file. CSV/TSV also works.
              </div>
              {importSummary && (
                <div className="inventory-stats" style={{ marginBottom: 12 }}>
                  <span className="status-chip">Uploaded rows {importSummary.totalRows || 0}</span>
                  <span className="status-chip">Inserted {importSummary.inserted || 0}</span>
                  <span className="status-chip">Updated {importSummary.updated || 0}</span>
                  <span className="status-chip">Batches {importSummary.batches || 0}</span>
                  {importSummary.errorRows ? <span className="status-chip">Errors {importSummary.errorRows}</span> : null}
                </div>
              )}

              <section className="product-dropbox-box">
                <div className="product-dropbox-header">
                  <div>
                    <h3>Product Dropbox</h3>
                    <p>{PRODUCT_DROPBOX_DAYS} days old, unused, zero-stock SKUs for password-protected cleanup.</p>
                  </div>
                  <button className="secondary-button" type="button" onClick={() => (isDropboxOpen ? setIsDropboxOpen(false) : loadProductDropbox())}>
                    {isDropboxOpen ? 'Close Dropbox' : 'Open Dropbox'}
                  </button>
                </div>

                {isDropboxOpen && (
                  <div className="product-dropbox-body">
                    <div className="product-dropbox-toolbar">
                      <input
                        className="field"
                        value={dropboxSearch}
                        onChange={(event) => setDropboxSearch(event.target.value)}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter') loadProductDropbox();
                        }}
                        placeholder="Search dropbox product, barcode, alias, code"
                      />
                      <button className="secondary-button" type="button" onClick={loadProductDropbox} disabled={isDropboxLoading}>
                        {isDropboxLoading ? 'Loading...' : 'Load'}
                      </button>
                      <button className="secondary-button" type="button" onClick={toggleAllDropboxRows} disabled={!dropboxRows.length}>
                        {selectedDropboxBarcodes.length === dropboxRows.length && dropboxRows.length ? 'Clear All' : 'Select All'}
                      </button>
                    </div>

                    <div className="inventory-stats">
                      <span className="status-chip">{dropboxSummary.total || 0} eligible</span>
                      <span className="status-chip">{selectedDropboxRows.length} selected</span>
                      <span className="status-chip">Zero stock only</span>
                    </div>

                    <div className="product-dropbox-approval">
                      <input
                        className="field"
                        value={dropboxApproval.username}
                        onChange={(event) => setDropboxApproval((current) => ({ ...current, username: event.target.value }))}
                        placeholder="Supervisor username"
                      />
                      <input
                        className="field"
                        type="password"
                        value={dropboxApproval.password}
                        onChange={(event) => setDropboxApproval((current) => ({ ...current, password: event.target.value }))}
                        placeholder="Supervisor password"
                      />
                      <button className="danger-button" type="button" onClick={deleteSelectedDropboxProducts} disabled={isDropboxDeleting || !selectedDropboxBarcodes.length}>
                        {isDropboxDeleting ? 'Deleting...' : 'Bulk Delete'}
                      </button>
                    </div>

                    <div className="bulk-table-wrap">
                      <table className="history-table">
                        <thead>
                          <tr><th></th><th>Barcode</th><th>Product</th><th>Last Activity</th><th>Stock</th><th>MRP</th></tr>
                        </thead>
                        <tbody>
                          {dropboxRows.length === 0 ? (
                            <tr><td colSpan="6">No old unused products in dropbox.</td></tr>
                          ) : (
                            dropboxRows.map((product) => (
                              <tr key={product.barcode}>
                                <td>
                                  <input
                                    type="checkbox"
                                    checked={selectedDropboxBarcodes.includes(product.barcode)}
                                    onChange={() => toggleDropboxRow(product.barcode)}
                                  />
                                </td>
                                <td className="mono muted">{product.barcode}</td>
                                <td>
                                  <strong>{product.product_name}</strong>
                                  {product.product_code && <div className="muted compact-cell-text">{product.product_code}</div>}
                                </td>
                                <td>{formatProductDate(product.last_activity_at || product.updated_at || product.created_at)}</td>
                                <td>{product.stock_qty}</td>
                                <td>{formatMoney(product.mrp)}</td>
                              </tr>
                            ))
                          )}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}
              </section>

              <section className="product-dropbox-box">
                <div className="product-dropbox-header">
                  <div>
                    <h3>Duplicate Product Codes</h3>
                    <p>Same product code attached to multiple SKUs. Keep the correct row and delete unwanted duplicates.</p>
                  </div>
                  <button className="secondary-button" type="button" onClick={() => (isDuplicateOpen ? setIsDuplicateOpen(false) : loadDuplicateCodes())}>
                    {isDuplicateOpen ? 'Close Duplicates' : 'Open Duplicates'}
                  </button>
                </div>

                {isDuplicateOpen && (
                  <div className="product-dropbox-body">
                    <div className="product-dropbox-toolbar">
                      <input
                        className="field"
                        value={duplicateSearch}
                        onChange={(event) => setDuplicateSearch(event.target.value)}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter') loadDuplicateCodes();
                        }}
                        placeholder="Search duplicate code, product, barcode"
                      />
                      <button className="secondary-button" type="button" onClick={loadDuplicateCodes} disabled={isDuplicateLoading}>
                        {isDuplicateLoading ? 'Loading...' : 'Load'}
                      </button>
                      <button className="secondary-button" type="button" onClick={selectDuplicateExtras} disabled={!duplicateGroups.length}>
                        Select Extras
                      </button>
                    </div>

                    <div className="inventory-stats">
                      <span className="status-chip">{duplicateSummary.duplicateCodes || 0} duplicate codes</span>
                      <span className="status-chip">{duplicateSummary.duplicateProducts || 0} products</span>
                      <span className="status-chip">{selectedDuplicateBarcodes.length} selected</span>
                    </div>

                    <div className="product-dropbox-approval">
                      <input
                        className="field"
                        value={duplicateApproval.username}
                        onChange={(event) => setDuplicateApproval((current) => ({ ...current, username: event.target.value }))}
                        placeholder="Supervisor username"
                      />
                      <input
                        className="field"
                        type="password"
                        value={duplicateApproval.password}
                        onChange={(event) => setDuplicateApproval((current) => ({ ...current, password: event.target.value }))}
                        placeholder="Supervisor password"
                      />
                      <button className="danger-button" type="button" onClick={deleteSelectedDuplicateProducts} disabled={isDuplicateDeleting || !selectedDuplicateBarcodes.length}>
                        {isDuplicateDeleting ? 'Deleting...' : 'Delete Selected'}
                      </button>
                    </div>

                    <div className="bulk-table-wrap">
                      <table className="history-table">
                        <thead>
                          <tr><th></th><th>Code</th><th>Barcode</th><th>Product</th><th>Stock</th><th>MRP</th><th>Updated</th></tr>
                        </thead>
                        <tbody>
                          {duplicateGroups.length === 0 ? (
                            <tr><td colSpan="7">No duplicate product codes found.</td></tr>
                          ) : (
                            duplicateGroups.flatMap((group) => group.products.map((product, index) => (
                              <tr key={product.barcode}>
                                <td>
                                  <input
                                    type="checkbox"
                                    checked={selectedDuplicateBarcodes.includes(product.barcode)}
                                    onChange={() => toggleDuplicateRow(product.barcode)}
                                  />
                                </td>
                                <td className="mono muted">{index === 0 ? group.product_code : ''}</td>
                                <td className="mono muted">{product.barcode}</td>
                                <td>
                                  <strong>{product.product_name}</strong>
                                  {index === 0 && <div className="muted compact-cell-text">Keep one row unselected for this code</div>}
                                </td>
                                <td>{product.stock_qty}</td>
                                <td>{formatMoney(product.mrp)}</td>
                                <td>{formatProductDate(product.updated_at || product.created_at)}</td>
                              </tr>
                            )))
                          )}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}
              </section>

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
                    <div key={`${rowError.row}-${rowError.barcode}`}>
                      Row {rowError.row}
                      {rowError.product_name ? ` - ${rowError.product_name}` : ''}
                      {rowError.product_code ? ` (${rowError.product_code})` : ''}: {rowError.message || rowError.errors.join(', ')}
                    </div>
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
              placeholder="Search product name, alias, barcode, or product code"
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
                  {showProductCodeColumn && <th>Code</th>}
                  <th>Product</th>
                  <th>GST</th>
                  <th>Unit</th>
                  <th>Purchase Pack</th>
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
                  <tr><td colSpan={inventoryColSpan}>No products found.</td></tr>
                ) : (
                  products.map((product) => {
                    const isLow = toNumber(product.stock_qty) <= toNumber(product.min_stock_alert, 10);
                    return (
                      <tr key={product.barcode}>
                        <td className="mono muted">{product.barcode}</td>
                        {showProductCodeColumn && <td>{product.product_code || '-'}</td>}
                        <td>
                          <strong>{product.product_name}</strong>
                          {product.alias_names && <div className="muted compact-cell-text">{product.alias_names}</div>}
                        </td>
                        <td>{product.gst_percent}%</td>
                        <td>{product.unit_type || 'Nos'}</td>
                        <td>{product.purchase_unit_type || 'Loose'} x {Number(product.purchase_unit_size || 1)}</td>
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
