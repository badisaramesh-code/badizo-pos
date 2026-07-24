import React, { useEffect, useRef, useState } from 'react';
import * as XLSX from 'xlsx';
import {
  bulkDeleteDuplicateProductCodes,
  bulkDeleteProductDropbox,
  bulkUpdateProducts,
  fetchBulkEditableProducts,
  fetchDuplicateProductCodes,
  fetchProductDropbox,
  fetchProductExpiryDashboard,
  exportProducts,
  fetchProductImportHistoryDetail,
  fetchProducts,
  getStoredUser,
  importProducts,
  fetchReorderSuggestions,
  lookupExactProduct,
  saveProduct,
  saveStockAdjustment,
  searchProducts
} from '../api/client';
import { formatMoney, toNumber } from '../utils/money';

const emptyForm = {
  original_barcode: '',
  product_code: '',
  code_mode: 'MANUAL',
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
  qty_3_price: '',
  qty_6_price: '',
  qty_12_price: '',
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
  default_batch_no: '',
  default_mfd_date: '',
  default_expiry_date: '',
  created_at: '',
  updated_at: ''
};

const GST_OPTIONS = ['0', '3', '5', '12', '18', '28', '40'];
const UNIT_OPTIONS = ['Nos', 'Gm', 'Kg', 'Ml', 'Ltr', 'Pack'];
const PURCHASE_UNIT_OPTIONS = ['Loose', 'Carton', 'Bag', 'Box', 'Case', 'Bundle', 'Pack'];
const PRODUCT_DROPBOX_DAYS = 365;
const ENABLE_BULK_EDIT = false;
const ACTIVE_IMPORT_STATUSES = new Set(['QUEUED', 'RUNNING']);
const PRODUCT_SECTIONS = {
  LIST: 'list',
  FORM: 'form',
  IMPORT: 'import',
  BULK: 'bulk',
  EXPIRY: 'expiry',
  ADJUSTMENT: 'adjustment',
  REORDER: 'reorder',
  MAINTENANCE: 'maintenance'
};
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
  'Sales Rate',
  'Wholesale Price',
  'Inward Quantity'
];

const PRODUCT_EXCEL_SAMPLE_ROWS = [
  ['73137', '89300296', '(180) JUMBO ROUND KAJU', '', '', '080211', '62.00', '62.00', '0', '2.5', '2.5', '5', '50 Gms', '62.00', '60.00', '10'],
  ['73138', '89300297', '(180) JUMBO ROUND KAJU', '', '', '080211', '120.00', '120.00', '0', '2.5', '2.5', '5', '100 Gms', '120.00', '116.00', '8'],
  ['73139', '89300298', '(180) JUMBO ROUND KAJU', '', '', '080211', '235.00', '235.00', '0', '2.5', '2.5', '5', '200 Gms', '235.00', '226.00', '5'],
  ['73140', '89300299', '(180) JUMBO ROUND KAJU', '', '', '080211', '580.00', '580.00', '0', '2.5', '2.5', '5', '500 Gms', '580.00', '560.00', '3']
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

function dateInputValue(value) {
  if (!value) return '';
  const text = String(value);
  if (/^\d{4}-\d{2}-\d{2}/.test(text)) return text.slice(0, 10);
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toISOString().slice(0, 10);
}

function productImportSummaryFromJob(job = {}) {
  return {
    status: job.status || '',
    totalRows: Number(job.total_rows || 0),
    validRows: Number(job.valid_rows || 0),
    inserted: Number(job.inserted_count || 0),
    updated: Number(job.updated_count || 0),
    errorRows: Number(job.error_rows || 0),
    skipped: Number(job.skipped_count || 0),
    batches: Number(job.batch_count || 0),
    failureMessage: job.failure_message || ''
  };
}

function productImportProgressPercent(summary = {}) {
  const totalRows = Number(summary.totalRows || 0);
  if (!totalRows) return 0;
  if (summary.status && !ACTIVE_IMPORT_STATUSES.has(summary.status)) return 100;
  const processedRows = Number(summary.inserted || 0) + Number(summary.updated || 0) + Number(summary.errorRows || 0);
  return Math.max(0, Math.min(100, Math.round((processedRows / totalRows) * 100)));
}

function productImportStatusChipClass(status, errorRows = 0) {
  if (status === 'SUCCESS') return 'status-chip success';
  if (status === 'PARTIAL SUCCESS' || Number(errorRows || 0) > 0) return 'status-chip warning';
  if (status === 'FAILED') return 'status-chip danger';
  if (ACTIVE_IMPORT_STATUSES.has(status)) return 'status-chip info';
  return 'status-chip';
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
    stock: columnIndex(['Inward Quantity', 'Inward Qty', 'Inward Stock', 'Opening Stock', 'stock_qty', 'stock', 'Stock Qty', 'Current Stock']),
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
        gst_percent: valueAt(row, indexes.gst),
        sales_sgst_percent: valueAt(row, indexes.sgst),
        sales_cgst_percent: valueAt(row, indexes.cgst),
        sales_igst_percent: valueAt(row, indexes.igst),
        unit_type: valueAt(row, indexes.unit),
        purchase_unit_type: valueAt(row, indexes.purchaseUnit),
        purchase_unit_size: valueAt(row, indexes.purchaseUnitSize),
        mrp: valueAt(row, indexes.mrp),
        purchase_price: valueAt(row, indexes.purchasePrice),
        sale_price: valueAt(row, indexes.salePrice),
        wholesale_price: valueAt(row, indexes.wholesalePrice),
        discount_type: discount ? 'VALUE' : '',
        discount_value: discount,
        bulk_discount_value: '',
        is_free_item: '',
        stock_qty: valueAt(row, indexes.stock),
        min_stock_alert: valueAt(row, indexes.lowStock)
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
    { wch: 16 },
    { wch: 16 },
    { wch: 18 }
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

export default function InventoryDashboardView({ isActive = false, navigationKey = 0, setActiveWorkspace } = {}) {
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
  const [activeImportId, setActiveImportId] = useState('');
  const [bulkSearch, setBulkSearch] = useState('');
  const [bulkRows, setBulkRows] = useState([]);
  const [bulkPatch, setBulkPatch] = useState({ hsn_code: '', gst_percent: '', unit_type: '' });
  const [isBulkLoading, setIsBulkLoading] = useState(false);
  const [isBulkSaving, setIsBulkSaving] = useState(false);
  const [bulkStatus, setBulkStatus] = useState('');
  const [bulkFocusVersion, setBulkFocusVersion] = useState(0);
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
  const [expiryDays, setExpiryDays] = useState(30);
  const [expiryRows, setExpiryRows] = useState([]);
  const [expirySummary, setExpirySummary] = useState({ expiredCount: 0, expiringCount: 0, expiredQty: 0, expiringQty: 0 });
  const [isExpiryLoading, setIsExpiryLoading] = useState(false);
  const [reorderRows, setReorderRows] = useState([]);
  const [isReorderLoading, setIsReorderLoading] = useState(false);
  const [adjustmentForm, setAdjustmentForm] = useState({ barcode: '', adjustment_qty: '', reason: 'DAMAGE', note: '' });
  const [adjustmentSuggestions, setAdjustmentSuggestions] = useState([]);
  const [isAdjustmentSaving, setIsAdjustmentSaving] = useState(false);
  const [activeProductSection, setActiveProductSection] = useState(PRODUCT_SECTIONS.LIST);
  const [statusMessage, setStatusMessage] = useState('');
  const [errorMessage, setErrorMessage] = useState('');
  const currentUser = getStoredUser();
  const canManageProducts = ['SERVER', 'ADMIN'].includes(currentUser?.role);
  const productCodeRef = useRef(null);
  const barcodeRef = useRef(null);
  const productNameRef = useRef(null);
  const aliasNamesRef = useRef(null);
  const hsnRef = useRef(null);
  const bulkSearchRef = useRef(null);
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
  const batchNumberRef = useRef(null);
  const mfdDateRef = useRef(null);
  const expiryDateRef = useRef(null);
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

  useEffect(() => {
    if (!activeImportId) return undefined;

    let cancelled = false;
    async function refreshActiveImport() {
      try {
        const detail = await fetchProductImportHistoryDetail(activeImportId);
        if (cancelled) return;

        const nextSummary = productImportSummaryFromJob(detail.job);
        setImportSummary((current) => ({ ...(current || {}), ...nextSummary }));

        if (!ACTIVE_IMPORT_STATUSES.has(nextSummary.status)) {
          const isFailed = nextSummary.status === 'FAILED';
          const isPartial = nextSummary.status === 'PARTIAL SUCCESS' || Number(nextSummary.errorRows || 0) > 0;
          const statusText = nextSummary.status || (isFailed ? 'FAILED' : 'SUCCESS');
          const message = `${statusText}: ${nextSummary.inserted || 0} inserted, ${nextSummary.updated || 0} updated, ${nextSummary.errorRows || 0} error rows.`;
          setImportGrowl({
            type: isFailed ? 'danger' : (isPartial ? 'warning' : 'success'),
            title: isFailed ? 'Product import failed' : (isPartial ? 'Product import partially completed' : 'Product import completed'),
            message: nextSummary.failureMessage ? `${message} ${nextSummary.failureMessage}` : message
          });
          setActiveImportId('');
          await loadProducts(1);
          setPage(1);
        }
      } catch (err) {
        if (!cancelled) setErrorMessage(err.response?.data?.error || 'Unable to refresh product import progress.');
      }
    }

    refreshActiveImport();
    const timer = window.setInterval(refreshActiveImport, 3000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [activeImportId]);

  useEffect(() => {
    if (activeProductSection === PRODUCT_SECTIONS.BULK) {
      if (!ENABLE_BULK_EDIT) {
        setActiveProductSection(PRODUCT_SECTIONS.LIST);
        return;
      }
      focusBulkSearch();
    }
  }, [activeProductSection]);

  useEffect(() => {
    if (activeProductSection === PRODUCT_SECTIONS.FORM) {
      focusBarcodeField();
    }
  }, [activeProductSection]);

  useEffect(() => {
    if (ENABLE_BULK_EDIT && activeProductSection === PRODUCT_SECTIONS.BULK && bulkFocusVersion > 0 && !isBulkSaving) {
      focusBulkSearch(4);
    }
  }, [activeProductSection, bulkFocusVersion, isBulkSaving]);

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

  function focusBarcodeField(attempts = 5) {
    const focusAttempt = (remaining) => {
      const input = barcodeRef.current;
      if (!input) {
        if (remaining > 1) window.setTimeout(() => focusAttempt(remaining - 1), 60);
        return;
      }
      input.focus({ preventScroll: true });
      const caretPosition = input.value.length;
      input.setSelectionRange?.(caretPosition, caretPosition);
      if (document.activeElement !== input && remaining > 1) {
        window.setTimeout(() => focusAttempt(remaining - 1), 60);
      }
    };
    window.requestAnimationFrame(() => focusAttempt(attempts));
  }

  function focusBulkSearch(attempts = 1) {
    const focusAttempt = (remaining) => {
      const input = bulkSearchRef.current;
      if (!input) return;
      input.disabled = false;
      input.readOnly = false;
      input.focus();
      input.select?.();
      if (remaining > 1 && document.activeElement !== input) {
        window.setTimeout(() => focusAttempt(remaining - 1), 60);
      }
    };

    window.requestAnimationFrame(() => {
      focusAttempt(attempts);
    });
  }

  function moveOnEnter(event, nextRef) {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    focusProductField(nextRef);
  }

  async function loadProductByBarcodeForEdit(nextRef = productNameRef) {
    const barcode = String(form.barcode || '').trim();
    if (!barcode || barcode === String(form.original_barcode || '').trim()) {
      focusProductField(nextRef);
      return;
    }

    try {
      const product = await lookupExactProduct(barcode);
      if (product) {
        editProduct(product);
        setStatusMessage(`${product.product_name} loaded for edit.`);
        focusProductField(productNameRef);
        return;
      }
    } catch (err) {
      setErrorMessage(err.response?.data?.error || 'Unable to load barcode product details.');
      return;
    }

    focusProductField(nextRef);
  }

  function barcodeLookupOnEnter(event) {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    loadProductByBarcodeForEdit(productNameRef);
  }

  function resetProductForm() {
    setForm({ ...emptyForm, created_at: todayIso(), updated_at: '' });
    focusBarcodeField();
  }

  function openNewProductForm() {
    setStatusMessage('');
    setErrorMessage('');
    setForm({ ...emptyForm, created_at: todayIso(), updated_at: '' });
    setActiveProductSection(PRODUCT_SECTIONS.FORM);
    focusBarcodeField();
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
      default_batch_no: String(source.default_batch_no ?? '').trim().toUpperCase(),
      default_mfd_date: dateInputValue(source.default_mfd_date),
      default_expiry_date: dateInputValue(source.default_expiry_date),
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
    const qty3Price = toNumber(productForm.qty_3_price);
    const qty6Price = toNumber(productForm.qty_6_price);
    const qty12Price = toNumber(productForm.qty_12_price);
    const purchasePrice = toNumber(productForm.purchase_price);
    const purchaseUnitSize = toNumber(productForm.purchase_unit_size);

    if (salePrice > mrp && mrp > 0) return 'Retail sale price cannot be greater than MRP.';
    if (wholesalePrice > mrp && mrp > 0) return 'Wholesale price cannot be greater than MRP.';
    if (qty3Price > mrp && mrp > 0) return '3+ price cannot be greater than MRP.';
    if (qty6Price > mrp && mrp > 0) return '6+ price cannot be greater than MRP.';
    if (qty12Price > mrp && mrp > 0) return '12+ price cannot be greater than MRP.';
    if (purchasePrice < 0) return 'Purchase price cannot be negative.';
    if (purchaseUnitSize <= 0) return 'Stock per purchase unit must be greater than zero.';
    if (productForm.free_promo_enabled && !uppercaseProductName(productForm.free_promo_name)) return 'Enter free item name for product promotion.';
    if (productForm.default_mfd_date && productForm.default_expiry_date && productForm.default_mfd_date >= productForm.default_expiry_date) {
      return 'MFD date must be before expiry date.';
    }
    return '';
  }

  function editProduct(product) {
    setForm({
      original_barcode: product.barcode || '',
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
      qty_3_price: Number(product.qty_3_price) > 0 ? String(product.qty_3_price) : '',
      qty_6_price: Number(product.qty_6_price) > 0 ? String(product.qty_6_price) : '',
      qty_12_price: Number(product.qty_12_price) > 0 ? String(product.qty_12_price) : '',
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
      default_batch_no: product.default_batch_no || '',
      default_mfd_date: dateInputValue(product.default_mfd_date),
      default_expiry_date: dateInputValue(product.default_expiry_date),
      created_at: product.created_at || product.updated_at || todayIso(),
      updated_at: product.updated_at || ''
    });
    setActiveProductSection(PRODUCT_SECTIONS.FORM);
    focusBarcodeField();
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
        original_barcode: String(productForm.original_barcode || '').trim().toUpperCase(),
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
      const acceptedRows = Number(result.summary?.acceptedRows || result.summary?.totalRows || 0);
      setImportSummary({ ...(result.summary || {}), status: result.status || 'QUEUED' });
      setActiveImportId(result.importId || '');
      setImportGrowl({
        type: 'info',
        title: 'Product import started',
        message: `${acceptedRows} row(s) accepted. Track live progress in Import History; product count updates after completion.`
      });
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

  async function searchBulkProducts(searchValue = bulkSearchRef.current?.value ?? bulkSearch) {
    const cleaned = String(searchValue || '').trim();
    setBulkSearch(cleaned);
    setStatusMessage('');
    setErrorMessage('');
    setBulkStatus('');
    setBulkRows([]);

    if (cleaned.length < 3) {
      setErrorMessage('Enter at least 3 letters or two words to search products for bulk edit.');
      focusProductField(bulkSearchRef);
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
      setBulkStatus(rows.length ? '' : 'No products found. Type another product name/barcode.');
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
      setBulkStatus('Continue.. next product edit');
      setBulkRows([]);
      setBulkPatch({ hsn_code: '', gst_percent: '', unit_type: '' });
      setBulkSearch('');
      setBulkFocusVersion((current) => current + 1);
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
      setStatusMessage(`${rows.length} products with no activity for 1 year loaded in Product Dropbox.`);
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

  async function loadExpiryDashboard() {
    setStatusMessage('');
    setErrorMessage('');
    setIsExpiryLoading(true);
    try {
      const result = await fetchProductExpiryDashboard({ days: expiryDays, limit: 500 });
      const rows = Array.isArray(result.rows) ? result.rows : [];
      setExpiryRows(rows);
      setExpirySummary(result.summary || { expiredCount: 0, expiringCount: rows.length, expiredQty: 0, expiringQty: 0 });
      setStatusMessage(`${rows.length} expiry batch(es) loaded for ${expiryDays} day review.`);
    } catch (err) {
      setErrorMessage(err.response?.data?.error || 'Unable to load expiry dashboard.');
    } finally {
      setIsExpiryLoading(false);
    }
  }

  async function loadReorderSuggestions() {
    setStatusMessage('');
    setErrorMessage('');
    setIsReorderLoading(true);
    try {
      const rows = await fetchReorderSuggestions({ limit: 500 });
      setReorderRows(rows);
      setStatusMessage(`${rows.length} low-stock product(s) loaded for reorder review.`);
    } catch (err) {
      setErrorMessage(err.response?.data?.error || 'Unable to load reorder suggestions.');
    } finally {
      setIsReorderLoading(false);
    }
  }

  async function searchAdjustmentProducts(query) {
    const cleaned = String(query || '').trim();
    setAdjustmentForm((current) => ({ ...current, barcode: cleaned.toUpperCase() }));
    if (cleaned.length < 3) {
      setAdjustmentSuggestions([]);
      return;
    }

    try {
      const rows = await searchProducts(cleaned);
      setAdjustmentSuggestions(rows.slice(0, 6));
    } catch (err) {
      setAdjustmentSuggestions([]);
    }
  }

  function selectAdjustmentProduct(product) {
    setAdjustmentForm((current) => ({ ...current, barcode: product.barcode || current.barcode }));
    setAdjustmentSuggestions([]);
  }

  async function submitStockAdjustment(event) {
    event.preventDefault();
    setStatusMessage('');
    setErrorMessage('');

    if (!adjustmentForm.barcode.trim()) {
      setErrorMessage('Enter barcode or select product before stock adjustment.');
      return;
    }

    if (!Number(adjustmentForm.adjustment_qty)) {
      setErrorMessage('Enter adjustment quantity. Use negative quantity for damage/expiry/wastage.');
      return;
    }

    const confirmed = window.confirm(`Apply stock adjustment ${adjustmentForm.adjustment_qty} for ${adjustmentForm.barcode}?`);
    if (!confirmed) return;

    setIsAdjustmentSaving(true);
    try {
      const result = await saveStockAdjustment({
        barcode: adjustmentForm.barcode,
        adjustment_qty: Number(adjustmentForm.adjustment_qty),
        reason: adjustmentForm.reason,
        note: adjustmentForm.note
      });
      setStatusMessage(`Stock adjusted for ${result.product_name}: ${result.old_qty} -> ${result.new_qty}.`);
      setAdjustmentForm({ barcode: '', adjustment_qty: '', reason: 'DAMAGE', note: '' });
      setAdjustmentSuggestions([]);
      await loadProducts(1);
      setPage(1);
    } catch (err) {
      setErrorMessage(err.response?.data?.error || 'Unable to save stock adjustment.');
    } finally {
      setIsAdjustmentSaving(false);
    }
  }

  const showProductCodeColumn = filter.trim().length > 0;
  const inventoryColSpan = showProductCodeColumn ? 16 : 15;
  const selectedDropboxRows = dropboxRows.filter((row) => selectedDropboxBarcodes.includes(row.barcode));
  const importStatus = importSummary?.status || (activeImportId ? 'QUEUED' : '');
  const importProgress = productImportProgressPercent(importSummary || {});
  const importProcessedRows = Number(importSummary?.inserted || 0) + Number(importSummary?.updated || 0) + Number(importSummary?.errorRows || 0);

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
      {activeProductSection === PRODUCT_SECTIONS.FORM && (
      <section className="panel product-form-panel">
        <div className="panel-header">
          <h2 className="panel-title">Add / Edit Product</h2>
          <button className="close-action-button" type="button" onClick={() => setActiveProductSection(PRODUCT_SECTIONS.LIST)}>Back to Products</button>
        </div>
        <form className="panel-body form-stack product-edit-grid" onSubmit={handleSubmit}>
          {errorMessage && <div className="alert-box">{errorMessage}</div>}
          {statusMessage && <div className="change-box">{statusMessage}</div>}
          {!canManageProducts && <div className="alert-box">Login as Admin or Server to save/import products.</div>}
          <div className="product-date-strip">
            <span>Product Created Date: <strong>{formatProductDate(form.created_at || form.updated_at)}</strong></span>
            <span>Product Edit Date: <strong>{formatProductDate(form.updated_at || form.created_at)}</strong></span>
          </div>

          <div className="segmented two product-code-mode-selector">
            <button type="button" className={form.code_mode === 'AUTO' ? 'active' : ''} onClick={() => updateField('code_mode', 'AUTO')}>Auto Code</button>
            <button type="button" className={form.code_mode === 'MANUAL' ? 'active' : ''} onClick={() => updateField('code_mode', 'MANUAL')}>Manual Code</button>
          </div>

          <label className="product-field-order-14">
            <span className="field-label">Product Code</span>
            <input
              ref={productCodeRef}
              className="field"
              value={form.product_code}
              onChange={(event) => updateField('product_code', event.target.value.toUpperCase())}
              onKeyDown={(event) => moveOnEnter(event, aliasNamesRef)}
              placeholder={form.code_mode === 'AUTO' ? 'Auto generated when empty' : 'Enter product code'}
            />
          </label>

          <label className="product-field-order-1">
            <span className="field-label">Product Code 128 (0-9, A-Z)</span>
            <input
              ref={barcodeRef}
              autoFocus
              className="field"
              value={form.barcode}
              onChange={(event) => updateField('barcode', event.target.value.toUpperCase())}
              onBlur={() => loadProductByBarcodeForEdit(productNameRef)}
              onKeyDown={barcodeLookupOnEnter}
              required
            />
          </label>

          <label className="product-field-order-2">
            <span className="field-label">Product name</span>
            <input ref={productNameRef} className="field" value={form.product_name} onChange={(event) => updateField('product_name', event.target.value)} onKeyDown={(event) => moveOnEnter(event, hsnRef)} required />
          </label>

          <label className="product-field-order-15">
            <span className="field-label">Alias / invoice names</span>
            <input
              ref={aliasNamesRef}
              className="field"
              value={form.alias_names}
              onChange={(event) => updateField('alias_names', event.target.value)}
              onKeyDown={(event) => moveOnEnter(event, purchaseUnitSizeRef)}
              placeholder="Supplier invoice names, comma separated"
            />
          </label>

          <label className="product-field-order-3">
            <span className="field-label">HSN code</span>
            <input ref={hsnRef} className="field" value={form.hsn_code} onChange={(event) => updateField('hsn_code', event.target.value)} onKeyDown={(event) => moveOnEnter(event, gstRef)} required />
          </label>

          <label className="product-field-order-4">
            <span className="field-label">GST percent</span>
            <select ref={gstRef} className="select" value={form.gst_percent} onChange={(event) => updateField('gst_percent', event.target.value)} onKeyDown={(event) => moveOnEnter(event, mrpRef)}>
              <option value="">Select GST</option>
              {GST_OPTIONS.map((gst) => <option key={gst} value={gst}>{gst}%</option>)}
            </select>
          </label>

          <label className="product-field-order-9">
            <span className="field-label">Selling / stock unit</span>
            <select ref={unitRef} className="select" value={form.unit_type} onChange={(event) => updateField('unit_type', event.target.value)} onKeyDown={(event) => moveOnEnter(event, purchaseUnitRef)}>
              <option value="">Select Unit</option>
              {UNIT_OPTIONS.map((unit) => <option key={unit} value={unit}>{unit}</option>)}
            </select>
          </label>

          <label className="product-field-order-10">
            <span className="field-label">Purchase unit</span>
            <select ref={purchaseUnitRef} className="select" value={form.purchase_unit_type} onChange={(event) => updateField('purchase_unit_type', event.target.value)} onKeyDown={(event) => moveOnEnter(event, discountTypeRef)}>
              {PURCHASE_UNIT_OPTIONS.map((unit) => <option key={unit} value={unit}>{unit}</option>)}
            </select>
          </label>

          <label className="product-field-order-16">
            <span className="field-label">Stock per purchase unit</span>
            <input
              ref={purchaseUnitSizeRef}
              className="field"
              type="number"
              step="0.001"
              min="0.001"
              value={form.purchase_unit_size}
              onChange={(event) => updateField('purchase_unit_size', event.target.value)}
              onKeyDown={(event) => moveOnEnter(event, stockRef)}
              placeholder="Carton 72 Nos / Bag 50 Kg"
              required
            />
          </label>

          <label className="product-field-order-5">
            <span className="field-label">MRP</span>
            <input ref={mrpRef} className="field" type="number" step="0.01" min="0" value={form.mrp} onChange={(event) => updateField('mrp', event.target.value)} onKeyDown={(event) => moveOnEnter(event, purchasePriceRef)} required />
          </label>

          <label className="product-field-order-6">
            <span className="field-label">Purchase price / Cost</span>
            <input ref={purchasePriceRef} className="field" type="number" step="0.01" min="0" value={form.purchase_price} onChange={(event) => updateField('purchase_price', event.target.value)} onKeyDown={(event) => moveOnEnter(event, salePriceRef)} placeholder="Cost to store" required />
          </label>

          <label className="product-field-order-7">
            <span className="field-label">Retail sale price</span>
            <input ref={salePriceRef} className="field" type="number" step="0.01" min="0" value={form.sale_price} onChange={(event) => updateField('sale_price', event.target.value)} onKeyDown={(event) => moveOnEnter(event, wholesalePriceRef)} required />
          </label>

          <label className="product-field-order-8">
            <span className="field-label">Wholesale price (optional)</span>
            <input ref={wholesalePriceRef} className="field" type="number" step="0.01" min="0" value={form.wholesale_price} onChange={(event) => updateField('wholesale_price', event.target.value)} onKeyDown={(event) => moveOnEnter(event, unitRef)} placeholder="Defaults to retail price" />
          </label>

          <label className="product-field-order-8">
            <span className="field-label">3+ Price (Qty 3–5, optional)</span>
            <input className="field" type="number" step="0.01" min="0" value={form.qty_3_price} onChange={(event) => updateField('qty_3_price', event.target.value)} placeholder="Leave empty to use normal price" />
          </label>

          <label className="product-field-order-8">
            <span className="field-label">6+ Price (Qty 6–11, optional)</span>
            <input className="field" type="number" step="0.01" min="0" value={form.qty_6_price} onChange={(event) => updateField('qty_6_price', event.target.value)} placeholder="Leave empty to use normal price" />
          </label>

          <label className="product-field-order-8">
            <span className="field-label">12+ Price (Qty 12+, optional)</span>
            <input className="field" type="number" step="0.01" min="0" value={form.qty_12_price} onChange={(event) => updateField('qty_12_price', event.target.value)} placeholder="Leave empty to use wholesale price" />
          </label>

          <label className="product-field-order-11">
            <span className="field-label">Discount Type</span>
            <select ref={discountTypeRef} className="select" value={form.discount_type} onChange={(event) => updateField('discount_type', event.target.value)} onKeyDown={(event) => moveOnEnter(event, discountRef)}>
              <option value="PERCENT">Percent</option>
              <option value="VALUE">Value</option>
            </select>
          </label>

          <label className="product-field-order-12">
            <span className="field-label">Discount</span>
            <input ref={discountRef} className="field" type="number" step="0.01" min="0" value={form.discount_value} onChange={(event) => updateField('discount_value', event.target.value)} onKeyDown={(event) => moveOnEnter(event, wholesaleDiscountRef)} required />
          </label>

          <label className="product-field-order-13">
            <span className="field-label">Wholesale Discount</span>
            <input ref={wholesaleDiscountRef} className="field" type="number" step="0.01" min="0" value={form.bulk_discount_value} onChange={(event) => updateField('bulk_discount_value', event.target.value)} onKeyDown={(event) => moveOnEnter(event, productCodeRef)} required />
          </label>

          <label className="change-box product-field-after">
            <input type="checkbox" checked={form.is_free_item} onChange={(event) => updateField('is_free_item', event.target.checked)} /> Free product entry
          </label>

          <label className="change-box product-field-after">
            <input type="checkbox" checked={form.free_promo_enabled} onChange={(event) => updateField('free_promo_enabled', event.target.checked)} /> Free promotion on this product
          </label>

          {form.free_promo_enabled && (
            <>
              <label className="product-field-after">
                <span className="field-label">Free item name on bill</span>
                <input className="field" value={form.free_promo_name} onChange={(event) => updateField('free_promo_name', event.target.value.toUpperCase())} placeholder="CRICKET BALL FREE" />
              </label>
              <label className="product-field-after">
                <span className="field-label">Free qty per sale qty</span>
                <input className="field" type="number" step="0.001" min="0.001" value={form.free_promo_qty_per_sale} onChange={(event) => updateField('free_promo_qty_per_sale', event.target.value)} />
              </label>
              <label className="product-field-after">
                <span className="field-label">Total promo count</span>
                <input className="field" type="number" step="0.01" min="0" value={form.free_promo_total_qty} onChange={(event) => updateField('free_promo_total_qty', event.target.value)} placeholder="0 or blank = no limit" />
              </label>
            </>
          )}

          <label className="product-field-after">
            <span className="field-label">Current stock</span>
            <input ref={stockRef} className="field" type="number" step="0.01" min="0" value={form.stock_qty} onChange={(event) => updateField('stock_qty', event.target.value)} onKeyDown={(event) => moveOnEnter(event, lowStockRef)} required />
          </label>

          <label className="product-field-after">
            <span className="field-label">Low stock alert</span>
            <input ref={lowStockRef} className="field" type="number" step="0.01" min="0" value={form.min_stock_alert} onChange={(event) => updateField('min_stock_alert', event.target.value)} onKeyDown={(event) => moveOnEnter(event, batchNumberRef)} required />
          </label>

          <label className="product-field-after">
            <span className="field-label">Batch number</span>
            <input
              ref={batchNumberRef}
              className="field"
              value={form.default_batch_no}
              onChange={(event) => updateField('default_batch_no', event.target.value.toUpperCase())}
              onKeyDown={(event) => moveOnEnter(event, mfdDateRef)}
              placeholder="Optional default"
            />
          </label>

          <label className="product-field-after">
            <span className="field-label">MFD date</span>
            <input
              ref={mfdDateRef}
              className="field"
              type="date"
              max={form.default_expiry_date || undefined}
              value={form.default_mfd_date}
              onChange={(event) => updateField('default_mfd_date', event.target.value)}
              onKeyDown={(event) => moveOnEnter(event, expiryDateRef)}
            />
          </label>

          <label className="product-field-after">
            <span className="field-label">Expiry date</span>
            <input
              ref={expiryDateRef}
              className="field"
              type="date"
              min={form.default_mfd_date || undefined}
              value={form.default_expiry_date}
              onChange={(event) => updateField('default_expiry_date', event.target.value)}
              onKeyDown={(event) => moveOnEnter(event, saveButtonRef)}
            />
          </label>

          <button ref={saveButtonRef} className="primary-button" type="submit" disabled={!canManageProducts}>Save Product</button>
          <button className="secondary-button" type="button" onClick={resetProductForm}>Clear</button>
        </form>
      </section>
      )}

      {activeProductSection !== PRODUCT_SECTIONS.FORM && (
      <section className="panel product-list-panel">
        <div className="panel-header">
          <div>
            <h2 className="panel-title">Products</h2>
            <div className="inventory-stats">
              <span className="status-chip">Total SKUs {summary.totalSku}</span>
              <span className="status-chip">{summary.lowStock} low stock</span>
              <span className="status-chip">{formatMoney(summary.inventoryValue)} value</span>
              <span className="status-chip">Showing {products.length} of {pagination.total}</span>
            </div>
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button className="primary-button compact-primary" type="button" onClick={openNewProductForm} disabled={!canManageProducts}>Add/Edit Product</button>
            <button className="secondary-button" type="button" onClick={() => setActiveProductSection(PRODUCT_SECTIONS.IMPORT)} disabled={!canManageProducts}>Import</button>
            <button className="secondary-button" type="button" onClick={exportProducts} disabled={!canManageProducts}>Export</button>
            <button className="secondary-button" type="button" onClick={() => { setActiveProductSection(PRODUCT_SECTIONS.EXPIRY); loadExpiryDashboard(); }} disabled={!canManageProducts}>Expiry</button>
            <button className="secondary-button" type="button" onClick={() => { setActiveProductSection(PRODUCT_SECTIONS.REORDER); loadReorderSuggestions(); }} disabled={!canManageProducts}>Reorder</button>
            {ENABLE_BULK_EDIT && (
              <button className="secondary-button" type="button" onClick={() => setActiveProductSection(PRODUCT_SECTIONS.BULK)} disabled={!canManageProducts}>Bulk Edit</button>
            )}
            <button className="secondary-button" type="button" onClick={() => setActiveProductSection(PRODUCT_SECTIONS.MAINTENANCE)} disabled={!canManageProducts}>Tools</button>
            <button className="secondary-button" type="button" onClick={() => setActiveWorkspace?.('importHistory')}>Import History</button>
            <button className="secondary-button" onClick={() => loadProducts()}>Refresh</button>
          </div>
        </div>
        <div className="panel-body">
          {canManageProducts && (
            <>
              <div className="product-section-tabs" role="tablist" aria-label="Product sections">
                <button type="button" className={activeProductSection === PRODUCT_SECTIONS.LIST ? 'active' : ''} onClick={() => setActiveProductSection(PRODUCT_SECTIONS.LIST)}>Product List</button>
                <button type="button" className={activeProductSection === PRODUCT_SECTIONS.IMPORT ? 'active' : ''} onClick={() => setActiveProductSection(PRODUCT_SECTIONS.IMPORT)}>Import Products</button>
                <button type="button" className={activeProductSection === PRODUCT_SECTIONS.EXPIRY ? 'active' : ''} onClick={() => { setActiveProductSection(PRODUCT_SECTIONS.EXPIRY); loadExpiryDashboard(); }}>Expiry Dashboard</button>
                <button type="button" className={activeProductSection === PRODUCT_SECTIONS.ADJUSTMENT ? 'active' : ''} onClick={() => setActiveProductSection(PRODUCT_SECTIONS.ADJUSTMENT)}>Stock Adjustment</button>
                <button type="button" className={activeProductSection === PRODUCT_SECTIONS.REORDER ? 'active' : ''} onClick={() => { setActiveProductSection(PRODUCT_SECTIONS.REORDER); loadReorderSuggestions(); }}>Reorder Suggestions</button>
                {ENABLE_BULK_EDIT && (
                  <button type="button" className={activeProductSection === PRODUCT_SECTIONS.BULK ? 'active' : ''} onClick={() => setActiveProductSection(PRODUCT_SECTIONS.BULK)}>Bulk Edit</button>
                )}
                <button type="button" className={activeProductSection === PRODUCT_SECTIONS.MAINTENANCE ? 'active' : ''} onClick={() => setActiveProductSection(PRODUCT_SECTIONS.MAINTENANCE)}>Maintenance</button>
              </div>
              {activeProductSection === PRODUCT_SECTIONS.IMPORT && (
                <section className="product-workflow-panel">
              <div className="import-toolbar">
                <button className="secondary-button" onClick={downloadProductExcelTemplate}>Download Sample Excel</button>
                <label className="secondary-button file-button">
                  {isImporting ? 'Uploading...' : 'Upload Products'}
                  <input type="file" accept=".xlsx,.xls,.csv,.tsv,.txt,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel,text/csv,text/tab-separated-values,text/plain" onChange={handleImportFile} disabled={isImporting} />
                </label>
                <button className="secondary-button" type="button" onClick={() => setActiveWorkspace?.('importHistory')}>Import History</button>
              </div>
              {importSummary && (
                <div className="import-progress-box">
                  <div className="import-progress-header">
                    <div>
                      <strong>{ACTIVE_IMPORT_STATUSES.has(importStatus) ? 'Import running' : 'Last import status'}</strong>
                      <div className="muted compact-cell-text">
                        {importProcessedRows} of {importSummary.totalRows || 0} rows processed
                      </div>
                    </div>
                    <span className={productImportStatusChipClass(importStatus, importSummary.errorRows)}>{importStatus || 'VALIDATED'}</span>
                  </div>
                  <div className="progress-track" aria-label="Product import progress">
                    <div className="progress-fill" style={{ width: `${importProgress}%` }} />
                  </div>
                  <div className="inventory-stats">
                    <span className="status-chip">Accepted {importSummary.acceptedRows || importSummary.totalRows || 0}</span>
                    <span className="status-chip">Inserted {importSummary.inserted || 0}</span>
                    <span className="status-chip">Updated {importSummary.updated || 0}</span>
                    <span className="status-chip">Batches {importSummary.batches || 0}</span>
                    {importSummary.errorRows ? <span className="status-chip warning">Errors {importSummary.errorRows}</span> : null}
                  </div>
                </div>
              )}
                </section>
              )}

              {activeProductSection === PRODUCT_SECTIONS.EXPIRY && (
                <section className="product-workflow-panel">
                  <div className="product-dropbox-header">
                    <div>
                      <h3>Expiry Dashboard</h3>
                      <p>Review expired and near-expiry batches before discounting, returning, or writing off stock.</p>
                    </div>
                    <div className="actions-row">
                      <select className="select" value={expiryDays} onChange={(event) => setExpiryDays(Number(event.target.value))}>
                        <option value={7}>7 days</option>
                        <option value={30}>30 days</option>
                        <option value={60}>60 days</option>
                        <option value={90}>90 days</option>
                      </select>
                      <button className="secondary-button" type="button" onClick={loadExpiryDashboard} disabled={isExpiryLoading}>
                        {isExpiryLoading ? 'Loading...' : 'Load Expiry'}
                      </button>
                    </div>
                  </div>
                  <div className="inventory-stats">
                    <span className="status-chip danger">Expired {expirySummary.expiredCount || 0}</span>
                    <span className="status-chip warning">Expiring {expirySummary.expiringCount || 0}</span>
                    <span className="status-chip">Expired Qty {expirySummary.expiredQty || 0}</span>
                    <span className="status-chip">Expiring Qty {expirySummary.expiringQty || 0}</span>
                  </div>
                  <div className="bulk-table-wrap">
                    <table className="history-table">
                      <thead>
                        <tr><th>Status</th><th>Expiry</th><th>Barcode</th><th>Product</th><th>Batch</th><th>Qty</th><th>MRP</th><th>Cost</th></tr>
                      </thead>
                      <tbody>
                        {expiryRows.length === 0 ? (
                          <tr><td colSpan="8">Load expiry dashboard to review batches.</td></tr>
                        ) : expiryRows.map((row) => (
                          <tr key={`${row.barcode}-${row.batch_no}-${row.expiry_date}`}>
                            <td><span className={row.expiry_status === 'EXPIRED' ? 'status-chip danger' : 'status-chip warning'}>{row.expiry_status === 'EXPIRED' ? 'Expired' : 'Near expiry'}</span></td>
                            <td>{formatProductDate(row.expiry_date)}</td>
                            <td className="mono muted">{row.barcode}</td>
                            <td>{row.product_name}</td>
                            <td>{row.batch_no || '-'}</td>
                            <td>{row.quantity_available}</td>
                            <td>{formatMoney(row.mrp)}</td>
                            <td>{formatMoney(row.purchase_price)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </section>
              )}

              {activeProductSection === PRODUCT_SECTIONS.ADJUSTMENT && (
                <section className="product-workflow-panel">
                  <div className="product-dropbox-header">
                    <div>
                      <h3>Stock Adjustment</h3>
                      <p>Record damage, expiry, wastage, theft, or stock-audit corrections with audit history.</p>
                    </div>
                  </div>
                  <form className="form-grid stock-adjustment-grid" onSubmit={submitStockAdjustment}>
                    <label className="supplier-lookup-field">
                      <span className="field-label">Barcode / Product</span>
                      <input
                        className="field"
                        value={adjustmentForm.barcode}
                        onChange={(event) => searchAdjustmentProducts(event.target.value)}
                        placeholder="Scan barcode or search product"
                      />
                      {adjustmentSuggestions.length > 0 && (
                        <div className="supplier-suggestions">
                          {adjustmentSuggestions.map((product) => (
                            <button key={product.barcode} type="button" className="supplier-suggestion-row" onClick={() => selectAdjustmentProduct(product)}>
                              <strong>{product.product_name}</strong>
                              <span>{product.barcode} | Stock {product.stock_qty}</span>
                            </button>
                          ))}
                        </div>
                      )}
                    </label>
                    <label>
                      <span className="field-label">Adjustment Qty</span>
                      <input
                        className="field"
                        type="number"
                        step="0.01"
                        value={adjustmentForm.adjustment_qty}
                        onChange={(event) => setAdjustmentForm((current) => ({ ...current, adjustment_qty: event.target.value }))}
                        placeholder="-2 for damage"
                      />
                    </label>
                    <label>
                      <span className="field-label">Reason</span>
                      <select className="select" value={adjustmentForm.reason} onChange={(event) => setAdjustmentForm((current) => ({ ...current, reason: event.target.value }))}>
                        <option value="DAMAGE">Damage</option>
                        <option value="EXPIRY">Expiry</option>
                        <option value="WASTAGE">Wastage</option>
                        <option value="THEFT">Theft</option>
                        <option value="STOCK_AUDIT">Stock Audit</option>
                        <option value="OTHER">Other</option>
                      </select>
                    </label>
                    <label>
                      <span className="field-label">Note</span>
                      <input className="field" value={adjustmentForm.note} onChange={(event) => setAdjustmentForm((current) => ({ ...current, note: event.target.value }))} placeholder="Optional note" />
                    </label>
                    <button className="primary-button compact-primary" type="submit" disabled={isAdjustmentSaving}>
                      {isAdjustmentSaving ? 'Saving...' : 'Save Adjustment'}
                    </button>
                  </form>
                </section>
              )}

              {activeProductSection === PRODUCT_SECTIONS.REORDER && (
                <section className="product-workflow-panel">
                  <div className="product-dropbox-header">
                    <div>
                      <h3>Reorder Suggestions</h3>
                      <p>Low-stock products based on current stock, alert quantity, and last 30 days sales movement.</p>
                    </div>
                    <button className="secondary-button" type="button" onClick={loadReorderSuggestions} disabled={isReorderLoading}>
                      {isReorderLoading ? 'Loading...' : 'Load Reorder'}
                    </button>
                  </div>
                  <div className="bulk-table-wrap">
                    <table className="history-table">
                      <thead>
                        <tr><th>Barcode</th><th>Product</th><th>Stock</th><th>Alert</th><th>Sold 30 Days</th><th>Suggested Qty</th><th>Purchase Unit</th><th>Cost</th></tr>
                      </thead>
                      <tbody>
                        {reorderRows.length === 0 ? (
                          <tr><td colSpan="8">Load reorder suggestions to review low-stock products.</td></tr>
                        ) : reorderRows.map((row) => (
                          <tr key={row.barcode}>
                            <td className="mono muted">{row.barcode}</td>
                            <td>{row.product_name}</td>
                            <td><strong>{row.stock_qty}</strong></td>
                            <td>{row.min_stock_alert}</td>
                            <td>{row.sold_last_30_days}</td>
                            <td><strong>{row.suggested_qty}</strong></td>
                            <td>{row.purchase_unit_type || 'Loose'} x {row.purchase_unit_size || 1}</td>
                            <td>{formatMoney(row.purchase_price)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </section>
              )}

              {activeProductSection === PRODUCT_SECTIONS.MAINTENANCE && (
                <>
              <section className="product-dropbox-box">
                <div className="product-dropbox-header">
                  <div>
                    <h3>Product Dropbox</h3>
                    <p>No sales or inward activity for 1 year, zero stock, and ready for password-protected review.</p>
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
                            <tr><td colSpan="6">No products have reached the 1-year unused review rule.</td></tr>
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

                </>
              )}

              {ENABLE_BULK_EDIT && activeProductSection === PRODUCT_SECTIONS.BULK && (
              <section className="bulk-edit-box">
                <div className="bulk-edit-toolbar">
                  <input
                    key={bulkFocusVersion}
                    ref={bulkSearchRef}
                    className="field"
                    autoFocus
                    value={bulkSearch}
                    onChange={(event) => setBulkSearch(event.target.value)}
                    onKeyDown={(event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        searchBulkProducts(event.currentTarget.value);
      }
    }}
                    placeholder="Bulk edit search: rice 500, atta 1kg, oil..."
                  />
                  <button className="secondary-button" onClick={() => searchBulkProducts()} disabled={isBulkLoading || isBulkSaving}>
                    {isBulkLoading ? 'Searching...' : 'Search'}
                  </button>
                </div>

                {bulkStatus && (
                  <div className="change-box">{bulkStatus}</div>
                )}

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
                      <button className="primary-button compact-primary" onClick={(event) => { event.currentTarget.blur(); saveBulkRows(); }} disabled={isBulkSaving}>
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
                              <td><input className="field mono" value={row.barcode} readOnly tabIndex={-1} /></td>
                              <td>
                                <input
                                  className="field"
                                  value={row.product_name}
                                  onChange={(event) => updateBulkRow(index, 'product_name', event.target.value.toUpperCase())}
                                />
                                {row.alias_names ? <div className="muted compact-cell-text">{row.alias_names}</div> : null}
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
              )}
            </>
          )}

          {activeProductSection === PRODUCT_SECTIONS.LIST && (
          <>
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

          <div className="inventory-table-wrap">
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
                  <th>Offer</th>
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
                        <td>
                          {product.is_free_item ? <span className="status-chip info">Free item</span> : null}
                          {product.free_promo_enabled ? (
                            <div className="offer-cell">
                              <span className="status-chip success">Free promo</span>
                              <span className="muted compact-cell-text">{product.free_promo_name || 'Free item offer'}</span>
                            </div>
                          ) : null}
                          {!product.is_free_item && !product.free_promo_enabled ? '-' : null}
                        </td>
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
          </>
          )}
        </div>
      </section>
      )}
    </div>
  );
}
