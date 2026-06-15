const express = require('express');
const router = express.Router();
const db = require('../config/db');
const { authenticate, authorize } = require('../middleware/auth');
const { csvEscape, csvLine } = require('../utils/formatters');
const { writeAuditLog } = require('../services/auditService');
const { logError } = require('../services/logger');
const crypto = require('crypto');

const PRODUCT_DROPBOX_DAYS = 365;
const PRODUCT_IMPORT_BATCH_SIZE = 1000;
const PRODUCT_IMPORT_LINE_LIMIT = 5000;
const PRODUCT_IMPORT_TAX_SYNC_LIMIT = 200;
const PRODUCT_IMPORT_HISTORY_INSERT_SIZE = 250;
const PRODUCT_IMPORT_ACTIVE_STATUSES = new Set(['QUEUED', 'RUNNING']);
const PRODUCT_IMPORT_COLUMNS = [
  'product_code',
  'barcode',
  'product_name',
  'alias_names',
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
  'free_promo_enabled',
  'free_promo_name',
  'free_promo_qty_per_sale',
  'free_promo_total_qty',
  'free_promo_remaining_qty',
  'stock_qty',
  'min_stock_alert'
];

function verifyPassword(password, storedValue) {
  const [salt, storedHash] = String(storedValue || '').split(':');
  if (!salt || !storedHash) return false;

  const candidateHash = crypto.pbkdf2Sync(password, salt, 100000, 64, 'sha512').toString('hex');
  const candidateBuffer = Buffer.from(candidateHash, 'hex');
  const storedBuffer = Buffer.from(storedHash, 'hex');
  return candidateBuffer.length === storedBuffer.length && crypto.timingSafeEqual(candidateBuffer, storedBuffer);
}

function toProduct(row) {
  return {
    id: row.id,
    product_code: row.product_code || '',
    barcode: row.barcode,
    product_name: row.product_name,
    alias_names: row.alias_names || '',
    hsn_code: row.hsn_code || '',
    gst_percent: Number(row.gst_percent || 0),
    sales_sgst_percent: Number(row.sales_sgst_percent || 0),
    sales_cgst_percent: Number(row.sales_cgst_percent || 0),
    sales_igst_percent: Number(row.sales_igst_percent || 0),
    unit_type: row.unit_type || 'Nos',
    purchase_unit_type: row.purchase_unit_type || 'Loose',
    purchase_unit_size: Number(row.purchase_unit_size || 1),
    mrp: Number(row.mrp || 0),
    purchase_price: Number(row.purchase_price || 0),
    sale_price: Number(row.sale_price || 0),
    wholesale_price: Number(row.wholesale_price || row.sale_price || 0),
    discount_type: row.discount_type || 'PERCENT',
    discount_value: Number(row.discount_value || 0),
    bulk_discount_value: Number(row.bulk_discount_value || 0),
    is_free_item: Boolean(row.is_free_item),
    free_promo_enabled: Boolean(row.free_promo_enabled),
    free_promo_name: row.free_promo_name || '',
    free_promo_qty_per_sale: Number(row.free_promo_qty_per_sale || 1),
    free_promo_total_qty: Number(row.free_promo_total_qty || 0),
    free_promo_remaining_qty: Number(row.free_promo_remaining_qty || 0),
    stock_qty: Number(row.stock_qty || 0),
    min_stock_alert: Number(row.min_stock_alert || 10),
    created_at: row.created_at,
    updated_at: row.updated_at
  };
}

function productSnapshot(row) {
  if (!row) return null;
  return {
    product_code: row.product_code || null,
    barcode: row.barcode,
    product_name: row.product_name,
    alias_names: row.alias_names || '',
    hsn_code: row.hsn_code || '',
    gst_percent: Number(row.gst_percent || 0),
    sales_sgst_percent: Number(row.sales_sgst_percent || 0),
    sales_cgst_percent: Number(row.sales_cgst_percent || 0),
    sales_igst_percent: Number(row.sales_igst_percent || 0),
    unit_type: row.unit_type || 'Nos',
    purchase_unit_type: row.purchase_unit_type || 'Loose',
    purchase_unit_size: Number(row.purchase_unit_size || 1),
    mrp: Number(row.mrp || 0),
    purchase_price: Number(row.purchase_price || 0),
    sale_price: Number(row.sale_price || 0),
    wholesale_price: Number(row.wholesale_price || row.sale_price || 0),
    discount_type: row.discount_type || 'PERCENT',
    discount_value: Number(row.discount_value || 0),
    bulk_discount_value: Number(row.bulk_discount_value || 0),
    is_free_item: row.is_free_item ? 1 : 0,
    free_promo_enabled: row.free_promo_enabled ? 1 : 0,
    free_promo_name: row.free_promo_name || '',
    free_promo_qty_per_sale: Number(row.free_promo_qty_per_sale || 1),
    free_promo_total_qty: Number(row.free_promo_total_qty || 0),
    free_promo_remaining_qty: Number(row.free_promo_remaining_qty || 0),
    stock_qty: Number(row.stock_qty || 0),
    min_stock_alert: Number(row.min_stock_alert || 10)
  };
}

async function createProductImportJob({ fileName = '', user, totalRows = 0 } = {}) {
  const importId = crypto.randomUUID();
  await db.query(
    `INSERT INTO product_import_jobs
     (id, file_name, status, total_rows, created_by)
     VALUES (?, ?, 'QUEUED', ?, ?)`,
    [importId, String(fileName || '').slice(0, 255), totalRows, user?.username || '']
  );
  return importId;
}

async function updateProductImportJob(connection, importId, summary, failureMessage = '', forcedStatus = '') {
  const status = forcedStatus || (summary.errorRows > 0 && summary.validRows > 0
    ? 'PARTIAL SUCCESS'
    : (summary.validRows > 0 ? 'SUCCESS' : 'FAILED'));
  await connection.query(
    `UPDATE product_import_jobs
     SET status = ?,
         total_rows = ?,
         valid_rows = ?,
         inserted_count = ?,
         updated_count = ?,
         error_rows = ?,
         skipped_count = ?,
         batch_count = ?,
         failure_message = ?
     WHERE id = ?`,
    [
      status,
      summary.totalRows || 0,
      summary.validRows || 0,
      summary.inserted || 0,
      summary.updated || 0,
      summary.errorRows || 0,
      summary.skipped || 0,
      summary.batches || 0,
      failureMessage || null,
      importId
    ]
  );
  return status;
}

async function updateProductImportProgress(connection, importId, summary, status = 'RUNNING', failureMessage = '') {
  await connection.query(
    `UPDATE product_import_jobs
     SET status = ?,
         total_rows = ?,
         valid_rows = ?,
         inserted_count = ?,
         updated_count = ?,
         error_rows = ?,
         skipped_count = ?,
         batch_count = ?,
         failure_message = ?
     WHERE id = ?`,
    [
      status,
      summary.totalRows || 0,
      summary.validRows || 0,
      summary.inserted || 0,
      summary.updated || 0,
      summary.errorRows || 0,
      summary.skipped || 0,
      summary.batches || 0,
      failureMessage || null,
      importId
    ]
  );
}

async function insertProductImportLine(connection, importId, line) {
  await connection.query(
    `INSERT INTO product_import_lines
     (import_id, row_no, product_code, barcode, product_name, action_status, error_message, previous_product_json, imported_product_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      importId,
      Number(line.row_no || 0),
      String(line.product_code || '').slice(0, 60),
      String(line.barcode || '').slice(0, 120),
      String(line.product_name || '').slice(0, 255),
      line.action_status,
      line.error_message || null,
      line.previous_product_json ? JSON.stringify(line.previous_product_json) : null,
      line.imported_product_json ? JSON.stringify(line.imported_product_json) : null
    ]
  );
}

async function insertProductImportLines(connection, importId, lines = []) {
  if (!lines.length) return;

  for (let index = 0; index < lines.length; index += PRODUCT_IMPORT_HISTORY_INSERT_SIZE) {
    const batch = lines.slice(index, index + PRODUCT_IMPORT_HISTORY_INSERT_SIZE);
    const placeholders = batch.map(() => '(?, ?, ?, ?, ?, ?, ?, ?, ?)').join(',');
    const values = batch.flatMap((line) => [
      importId,
      Number(line.row_no || 0),
      String(line.product_code || '').slice(0, 60),
      String(line.barcode || '').slice(0, 120),
      String(line.product_name || '').slice(0, 255),
      line.action_status,
      line.error_message || null,
      line.previous_product_json ? JSON.stringify(line.previous_product_json) : null,
      line.imported_product_json ? JSON.stringify(line.imported_product_json) : null
    ]);

    await connection.query(
      `INSERT INTO product_import_lines
       (import_id, row_no, product_code, barcode, product_name, action_status, error_message, previous_product_json, imported_product_json)
       VALUES ${placeholders}`,
      values
    );
  }
}

function normalizeProductName(value) {
  return String(value || '').trim().replace(/\s+/g, ' ').toUpperCase();
}

function normalizeAliasNames(value) {
  return String(value || '')
    .split(/[,;\n]+/)
    .map(normalizeProductName)
    .filter(Boolean)
    .filter((name, index, list) => list.indexOf(name) === index)
    .join(', ');
}

function parseImportNumber(value, fallback = 0) {
  if (value === null || value === undefined) return fallback;
  const raw = String(value).replace(/\u00a0/g, ' ').trim();
  if (!raw) return fallback;
  const normalized = raw.replace(/\u20b9/g, '')
    .replace(/[₹,\s]/g, '')
    .replace(/%$/g, '')
    .replace(/^rs\.?/i, '');
  const number = Number(normalized);
  return Number.isFinite(number) ? number : Number.NaN;
}

function hasImportValue(value) {
  return String(value ?? '').trim() !== '';
}

function compactImportValue(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, 80);
}

function importErrorMessage(errors, rawValues = {}) {
  const values = Object.entries(rawValues)
    .filter(([, value]) => compactImportValue(value) !== '')
    .map(([key, value]) => `${key}="${compactImportValue(value)}"`)
    .join(', ');
  return values ? `${errors.join(', ')}. Values: ${values}` : errors.join(', ');
}

function formatProductImportDbError(product, err) {
  const message = String(err?.message || '');
  if (err?.code === 'ER_DUP_ENTRY' || /Duplicate entry/i.test(message)) {
    if (/product_code/i.test(message)) {
      return `Duplicate product code already exists in products: ${product.product_code}. This row was not imported.`;
    }
    if (/barcode/i.test(message)) {
      return `Duplicate product already imported with barcode ${product.barcode}. This row was not imported.`;
    }
    return `Duplicate product already exists. Product code: ${product.product_code || '-'}, barcode: ${product.barcode || '-'}.`;
  }
  return `Database row import failed: ${message}`;
}

const PRODUCT_CSV_HEADERS = [
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

const PRODUCT_EXPORT_HEADERS = [
  'product_code',
  'barcode',
  'product_name',
  'alias_names',
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
  'free_promo_enabled',
  'free_promo_name',
  'free_promo_qty_per_sale',
  'free_promo_total_qty',
  'free_promo_remaining_qty',
  'stock_qty',
  'min_stock_alert'
];

const PRODUCT_IMPORT_ALIASES = {
  sno: ['sno', 's no', 'sl no', 'serial', 'serial no'],
  product_code: ['product code', 'product_code', 'item code', 'code', 'plu code'],
  barcode: ['barcode', 'bar code', 'ean', 'ean code'],
  product_name: ['description', 'product name', 'product', 'item name', 'item', 'name'],
  alias_names: ['alias names', 'aliases', 'alias', 'invoice names', 'invoice name', 'supplier names', 'supplier product names'],
  free_promo_name: ['free product name', 'free product', 'free item name', 'free promo name', 'free_promo_name'],
  hsn_code: ['hsn', 'hsn code', 'hsn/sac', 'hsn sac'],
  gst_percent: ['sales gst %', 'sale gst %', 'sale gst', 'gst %', 'gst', 'tax %', 'tax'],
  sales_sgst_percent: ['sales sgst %', 'sale sgst %', 'sgst %', 'sgst', 'sales_sgst_percent'],
  sales_cgst_percent: ['sales cgst %', 'sale cgst %', 'cgst %', 'cgst', 'sales_cgst_percent'],
  sales_igst_percent: ['sales igst %', 'sale igst %', 'igst %', 'igst', 'sales_igst_percent'],
  unit_type: ['unit', 'units', 'unit type', 'uom'],
  purchase_unit_type: ['purchase unit', 'purchase_unit_type', 'purchase pack', 'purchase pack unit', 'pack type'],
  purchase_unit_size: ['stock per purchase unit', 'purchase_unit_size', 'units per pack', 'qty per pack', 'pcs per carton', 'kg per bag', 'conversion'],
  mrp: ['mrp', 'm r p'],
  purchase_price: ['purchase price', 'purchase rate', 'cost price', 'cost'],
  discount_value: ['discount', 'disc', 'disc %', 'discount %'],
  sale_price: ['sales rate', 'sale rate', 'sale net price', 'sale price', 'selling price', 'retail price', 'net price'],
  wholesale_price: ['wholesale price', 'wholesale rate'],
  stock_qty: ['inward quantity', 'inward qty', 'inward stock', 'opening stock', 'stock', 'stock qty', 'current stock'],
  min_stock_alert: ['low stock alert', 'min stock alert', 'minimum stock']
};

function parseCsv(text) {
  const rows = [];
  let row = [];
  let value = '';
  let inQuotes = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const nextChar = text[index + 1];

    if (char === '"' && inQuotes && nextChar === '"') {
      value += '"';
      index += 1;
    } else if (char === '"') {
      inQuotes = !inQuotes;
    } else if (char === ',' && !inQuotes) {
      row.push(value);
      value = '';
    } else if ((char === '\n' || char === '\r') && !inQuotes) {
      if (char === '\r' && nextChar === '\n') index += 1;
      row.push(value);
      if (row.some((cell) => cell.trim() !== '')) rows.push(row);
      row = [];
      value = '';
    } else {
      value += char;
    }
  }

  row.push(value);
  if (row.some((cell) => cell.trim() !== '')) rows.push(row);
  return rows;
}

function normalizeCsvRow(rawRow, rowNumber) {
  const productCode = String(rawRow.product_code || '').trim().toUpperCase();
  const barcode = String(rawRow.barcode || productCode || '').trim().toUpperCase();
  const importFields = {
    product_code: hasImportValue(rawRow.product_code),
    product_name: hasImportValue(rawRow.product_name),
    alias_names: hasImportValue(rawRow.alias_names),
    free_promo_name: hasImportValue(rawRow.free_promo_name),
    hsn_code: hasImportValue(rawRow.hsn_code),
    gst_percent: hasImportValue(rawRow.gst_percent),
    sales_sgst_percent: hasImportValue(rawRow.sales_sgst_percent),
    sales_cgst_percent: hasImportValue(rawRow.sales_cgst_percent),
    sales_igst_percent: hasImportValue(rawRow.sales_igst_percent),
    unit_type: hasImportValue(rawRow.unit_type),
    purchase_unit_type: hasImportValue(rawRow.purchase_unit_type),
    purchase_unit_size: hasImportValue(rawRow.purchase_unit_size),
    mrp: hasImportValue(rawRow.mrp),
    purchase_price: hasImportValue(rawRow.purchase_price),
    sale_price: hasImportValue(rawRow.sale_price) || hasImportValue(rawRow.mrp),
    wholesale_price: hasImportValue(rawRow.wholesale_price),
    discount_type: hasImportValue(rawRow.discount_type),
    discount_value: hasImportValue(rawRow.discount_value),
    bulk_discount_value: hasImportValue(rawRow.bulk_discount_value),
    is_free_item: hasImportValue(rawRow.is_free_item),
    free_promo_enabled: hasImportValue(rawRow.free_promo_name),
    free_promo_qty_per_sale: false,
    free_promo_total_qty: false,
    free_promo_remaining_qty: false,
    stock_qty: hasImportValue(rawRow.stock_qty),
    min_stock_alert: hasImportValue(rawRow.min_stock_alert)
  };
  const productName = normalizeProductName(rawRow.product_name);
  const aliasNames = normalizeAliasNames(rawRow.alias_names);
  const salesGstPercent = importFields.gst_percent ? parseImportNumber(rawRow.gst_percent, 0) : 0;
  const salesSgstPercent = importFields.sales_sgst_percent ? parseImportNumber(rawRow.sales_sgst_percent, 0) : 0;
  const salesCgstPercent = importFields.sales_cgst_percent ? parseImportNumber(rawRow.sales_cgst_percent, 0) : 0;
  const salesIgstPercent = importFields.sales_igst_percent ? parseImportNumber(rawRow.sales_igst_percent, 0) : 0;
  const splitGstPercent = salesCgstPercent + salesSgstPercent;
  const gstPercent = salesIgstPercent > 0 ? salesIgstPercent : (splitGstPercent > 0 ? splitGstPercent : salesGstPercent);
  const mrp = importFields.mrp ? parseImportNumber(rawRow.mrp, 0) : 0;
  const purchasePrice = importFields.purchase_price ? parseImportNumber(rawRow.purchase_price, 0) : 0;
  const purchaseUnitSize = importFields.purchase_unit_size ? parseImportNumber(rawRow.purchase_unit_size, 1) : 1;
  const salePrice = importFields.sale_price ? parseImportNumber(rawRow.sale_price || rawRow.mrp, 0) : 0;
  const wholesalePrice = importFields.wholesale_price ? parseImportNumber(rawRow.wholesale_price, 0) : salePrice;
  const discountValue = importFields.discount_value ? parseImportNumber(rawRow.discount_value, 0) : 0;
  const stockQty = importFields.stock_qty ? parseImportNumber(rawRow.stock_qty, 0) : 0;

  const errors = [];
  if (!barcode) errors.push('Product Code or barcode is required');
  if ((importFields.gst_percent || importFields.sales_sgst_percent || importFields.sales_cgst_percent || importFields.sales_igst_percent)
    && (!Number.isFinite(gstPercent) || ![0, 3, 5, 12, 18, 28, 40].includes(gstPercent))) errors.push('gst_percent must be 0, 3, 5, 12, 18, 28, or 40');
  if (![salesSgstPercent, salesCgstPercent, salesIgstPercent].every((tax) => Number.isFinite(tax) && tax >= 0 && tax <= 100)) errors.push('sales tax split percentages must be valid numbers');
  if (importFields.mrp && (!Number.isFinite(mrp) || mrp < 0)) errors.push('mrp must be a valid number');
  if (importFields.purchase_unit_size && (!Number.isFinite(purchaseUnitSize) || purchaseUnitSize <= 0)) errors.push('purchase_unit_size must be greater than zero');
  if (importFields.purchase_price && (!Number.isFinite(purchasePrice) || purchasePrice < 0)) errors.push('purchase_price must be a valid number');
  if (importFields.sale_price && (!Number.isFinite(salePrice) || salePrice < 0)) errors.push('sale_price must be a valid number');
  if (importFields.stock_qty && (!Number.isFinite(stockQty) || stockQty < 0)) errors.push('Inward Quantity must be a valid zero or positive number');
  if (importFields.mrp && importFields.sale_price && mrp > 0 && salePrice > mrp) errors.push('sale_price cannot be greater than mrp');

  return {
    rowNumber,
    rawValues: {
      product_code: rawRow.product_code,
      barcode: rawRow.barcode,
      description: rawRow.product_name,
      mrp: rawRow.mrp,
      purchase_rate: rawRow.purchase_price,
      sales_gst: rawRow.gst_percent,
      sales_sgst: rawRow.sales_sgst_percent,
      sales_cgst: rawRow.sales_cgst_percent,
      sales_igst: rawRow.sales_igst_percent,
      unit: rawRow.unit_type,
      sales_rate: rawRow.sale_price,
      inward_quantity: rawRow.stock_qty
    },
    errors,
    product: {
      product_code: productCode || null,
      source_row: rowNumber,
      barcode,
      product_name: productName,
      alias_names: aliasNames,
      hsn_code: String(rawRow.hsn_code || '').trim(),
      gst_percent: gstPercent,
      sales_sgst_percent: salesSgstPercent,
      sales_cgst_percent: salesCgstPercent,
      sales_igst_percent: salesIgstPercent,
      unit_type: normalizeUnitType(rawRow.unit_type),
      purchase_unit_type: normalizePurchaseUnitType(rawRow.purchase_unit_type),
      purchase_unit_size: purchaseUnitSize > 0 ? purchaseUnitSize : 1,
      mrp,
      purchase_price: purchasePrice,
      sale_price: salePrice,
      wholesale_price: Number.isFinite(wholesalePrice) ? wholesalePrice : salePrice,
      discount_type: String(rawRow.discount_type || (discountValue ? 'VALUE' : 'PERCENT')).trim().toUpperCase() === 'VALUE' ? 'VALUE' : 'PERCENT',
      discount_value: discountValue,
      bulk_discount_value: parseImportNumber(rawRow.bulk_discount_value, 0) || 0,
      is_free_item: ['1', 'TRUE', 'YES', 'Y'].includes(String(rawRow.is_free_item || '').trim().toUpperCase()) ? 1 : 0,
      free_promo_enabled: normalizeProductName(rawRow.free_promo_name) ? 1 : 0,
      free_promo_name: normalizeProductName(rawRow.free_promo_name),
      free_promo_qty_per_sale: 1,
      free_promo_total_qty: 0,
      free_promo_remaining_qty: 0,
      stock_qty: stockQty,
      import_fields: importFields,
      import_stock_qty_present: importFields.stock_qty,
      min_stock_alert: parseImportNumber(rawRow.min_stock_alert, 10) || 10
    }
  };
}

function normalizeHeaderName(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[().:%]/g, '')
    .replace(/[_/-]+/g, ' ')
    .replace(/\s+/g, ' ');
}

function mapImportHeaders(headers) {
  return headers.map((header) => {
    const normalized = normalizeHeaderName(header);
    const match = Object.entries(PRODUCT_IMPORT_ALIASES).find(([, aliases]) => (
      aliases.map(normalizeHeaderName).includes(normalized)
    ));
    return match ? match[0] : normalized.replace(/\s+/g, '_');
  });
}

function normalizeUnitType(value) {
  const unit = String(value || 'Nos').trim();
  const allowed = ['Nos', 'Gm', 'Kg', 'Ml', 'Ltr', 'Pack'];
  if (allowed.includes(unit)) return unit;
  return unit ? unit.slice(0, 30) : 'Nos';
}

function normalizePurchaseUnitType(value) {
  const unit = String(value || 'Loose').trim();
  const allowed = ['Loose', 'Carton', 'Bag', 'Box', 'Case', 'Bundle', 'Pack'];
  const match = allowed.find((item) => item.toLowerCase() === unit.toLowerCase());
  return match || (unit ? unit.slice(0, 30) : 'Loose');
}

function getProductIdentityNames(productName, aliasNames) {
  return [productName, ...String(aliasNames || '').split(',')]
    .map(normalizeProductName)
    .filter(Boolean)
    .filter((name, index, list) => list.indexOf(name) === index);
}

async function syncProductTaxByName(connection, { productName, aliasNames, hsnCode, gstPercent }) {
  const names = getProductIdentityNames(productName, aliasNames);
  if (!names.length || !String(hsnCode || '').trim() || !Number.isFinite(Number(gstPercent))) {
    return 0;
  }

  const conditions = [];
  const values = [];
  names.forEach((name) => {
    conditions.push('(product_name = ? OR FIND_IN_SET(?, REPLACE(alias_names, ", ", ",")) > 0)');
    values.push(name, name);
  });

  const [result] = await connection.query(
    `UPDATE products
     SET hsn_code = ?, gst_percent = ?, updated_at = CURRENT_TIMESTAMP
     WHERE ${conditions.join(' OR ')}`,
    [String(hsnCode || '').trim(), Number(gstPercent), ...values]
  );

  return Number(result?.affectedRows || 0);
}

function applyProductSearch(where, values, search) {
  const tokens = String(search || '')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 6);

  if (!tokens.length) return;

  tokens.forEach((token) => {
    where.push('(product_name LIKE ? OR alias_names LIKE ? OR barcode LIKE ? OR product_code LIKE ?)');
    values.push(`%${token}%`, `%${token}%`, `%${token}%`, `%${token}%`);
  });
}

function normalizeDropboxDays(value) {
  return Math.min(Math.max(Number.parseInt(value, 10) || PRODUCT_DROPBOX_DAYS, 365), 3650);
}

function cutoffDateForDays(days) {
  return new Date(Date.now() - (days * 24 * 60 * 60 * 1000))
    .toISOString()
    .slice(0, 19)
    .replace('T', ' ');
}

function buildDropboxBaseQuery({ search = '', barcodes = [], ageDays = PRODUCT_DROPBOX_DAYS } = {}) {
  const cutoffDate = cutoffDateForDays(normalizeDropboxDays(ageDays));
  const values = [cutoffDate];
  // Dropbox candidates are products with no sale/inward activity after the cutoff and no sellable stock.
  const where = [
    'COALESCE(activity.last_activity_at, p.updated_at, p.created_at) < ?',
    'p.stock_qty <= 0',
    'COALESCE(batch_stock.available_qty, 0) <= 0'
  ];

  applyProductSearch(where, values, search);

  if (barcodes.length) {
    where.push(`p.barcode IN (${barcodes.map(() => '?').join(',')})`);
    values.push(...barcodes);
  }

  return {
    values,
    whereSql: `WHERE ${where.join(' AND ')}`,
    fromSql: `
      FROM products p
      LEFT JOIN (
        SELECT barcode, MAX(activity_at) AS last_activity_at
        FROM (
          SELECT ii.barcode, i.created_at AS activity_at
          FROM invoice_items ii
          INNER JOIN invoices i ON i.invoice_no = ii.invoice_no
          WHERE COALESCE(i.invoice_status, 'PAID') <> 'CANCELLED'
          UNION ALL
          SELECT iw.barcode, ie.created_at AS activity_at
          FROM inward_items iw
          INNER JOIN inward_entries ie ON ie.inward_no = iw.inward_no
          WHERE COALESCE(ie.posting_status, 'POSTED') = 'POSTED'
        ) product_activity
        GROUP BY barcode
      ) activity ON activity.barcode = p.barcode
      LEFT JOIN (
        SELECT barcode, SUM(quantity_available) AS available_qty
        FROM product_batches
        GROUP BY barcode
      ) batch_stock ON batch_stock.barcode = p.barcode
    `
  };
}

router.get('/dropbox', authenticate, authorize('SERVER', 'ADMIN'), async (req, res) => {
  try {
    const search = String(req.query.search || '').trim();
    const limit = Math.min(Math.max(Number.parseInt(req.query.limit, 10) || 500, 50), 1000);
    const ageDays = normalizeDropboxDays(req.query.ageDays);
    const query = buildDropboxBaseQuery({ search, ageDays });

    const [summaryRows] = await db.query(
      `SELECT COUNT(*) AS total, COALESCE(SUM(p.stock_qty), 0) AS stock_qty
       ${query.fromSql}
       ${query.whereSql}`,
      query.values
    );

    const [rows] = await db.query(
      `SELECT p.*,
              activity.last_activity_at,
              COALESCE(batch_stock.available_qty, 0) AS batch_available_qty
       ${query.fromSql}
       ${query.whereSql}
       ORDER BY COALESCE(activity.last_activity_at, p.updated_at, p.created_at) ASC, p.product_name ASC
       LIMIT ?`,
      [...query.values, limit]
    );

    res.json({
      ageDays,
      cutoffDate: cutoffDateForDays(ageDays),
      summary: {
        total: Number(summaryRows[0]?.total || 0),
        stockQty: Number(summaryRows[0]?.stock_qty || 0)
      },
      rows: (rows || []).map((row) => ({
        ...toProduct(row),
        last_activity_at: row.last_activity_at || row.updated_at || row.created_at,
        batch_available_qty: Number(row.batch_available_qty || 0)
      }))
    });
  } catch (err) {
    console.error('Product dropbox load failed:', err.message);
    res.status(500).json({ error: 'Unable to load product dropbox.' });
  }
});

router.delete('/dropbox/bulk-delete', authenticate, authorize('SERVER', 'ADMIN'), async (req, res) => {
  const barcodes = Array.isArray(req.body?.barcodes)
    ? req.body.barcodes.map((barcode) => String(barcode || '').trim().toUpperCase()).filter(Boolean)
    : [];
  const username = String(req.body?.username || '').trim();
  const password = String(req.body?.password || '');
  const ageDays = normalizeDropboxDays(req.body?.ageDays);

  if (!barcodes.length) {
    return res.status(400).json({ error: 'Select at least one dropbox product to delete.' });
  }

  if (!username || !password) {
    return res.status(400).json({ error: 'Supervisor username and password are required.' });
  }

  const connection = await db.getConnection();
  try {
    const [userRows] = await connection.query(
      `SELECT id, username, password_hash, role, is_active
       FROM users
       WHERE username = ?
       LIMIT 1`,
      [username]
    );
    const supervisor = userRows[0];
    const allowedRole = ['SERVER', 'ADMIN'].includes(supervisor?.role);
    if (!supervisor || !supervisor.is_active || !allowedRole || !verifyPassword(password, supervisor.password_hash)) {
      return res.status(401).json({ error: 'Supervisor password approval failed.' });
    }

    const query = buildDropboxBaseQuery({ barcodes, ageDays });
    const [candidateRows] = await connection.query(
      `SELECT p.barcode, p.product_name
       ${query.fromSql}
       ${query.whereSql}`,
      query.values
    );
    const deleteBarcodes = candidateRows.map((row) => row.barcode);

    if (!deleteBarcodes.length) {
      return res.status(400).json({ error: 'Selected products are no longer eligible for dropbox deletion.' });
    }

    await connection.beginTransaction();
    const placeholders = deleteBarcodes.map(() => '?').join(',');
    await connection.query(`DELETE FROM product_batches WHERE barcode IN (${placeholders})`, deleteBarcodes);
    const [deleteResult] = await connection.query(`DELETE FROM products WHERE barcode IN (${placeholders})`, deleteBarcodes);

    await writeAuditLog({
      user: req.user,
      action: 'PRODUCT_DROPBOX_BULK_DELETED',
      entityType: 'PRODUCT',
      entityId: `${Number(deleteResult?.affectedRows || 0)} products`,
      details: {
        approved_by: supervisor.username,
        age_days: ageDays,
        requested_count: barcodes.length,
        deleted_count: Number(deleteResult?.affectedRows || 0),
        skipped_count: barcodes.length - deleteBarcodes.length,
        barcodes: deleteBarcodes.slice(0, 200)
      },
      connection
    });

    await connection.commit();
    res.json({
      success: true,
      deleted: Number(deleteResult?.affectedRows || 0),
      skipped: barcodes.length - deleteBarcodes.length
    });
  } catch (err) {
    try {
      await connection.rollback();
    } catch (_rollbackErr) {
      // Ignore rollback failure; original error is more useful.
    }
    console.error('Product dropbox delete failed:', err.message);
    res.status(500).json({ error: 'Unable to delete product dropbox items.' });
  } finally {
    connection.release();
  }
});

router.get('/duplicate-codes', authenticate, authorize('SERVER', 'ADMIN'), async (req, res) => {
  try {
    const search = String(req.query.search || '').trim();
    const limit = Math.min(Math.max(Number.parseInt(req.query.limit, 10) || 100, 10), 500);
    const values = [];
    const duplicateWhere = [`product_code IS NOT NULL`, `TRIM(product_code) <> ''`];

    if (search) {
      duplicateWhere.push('(product_code LIKE ? OR product_name LIKE ? OR alias_names LIKE ? OR barcode LIKE ?)');
      values.push(`%${search}%`, `%${search}%`, `%${search}%`, `%${search}%`);
    }

    const [codeRows] = await db.query(
      `SELECT product_code, COUNT(*) AS item_count
       FROM products
       WHERE ${duplicateWhere.join(' AND ')}
       GROUP BY product_code
       HAVING COUNT(*) > 1
       ORDER BY item_count DESC, product_code ASC
       LIMIT ?`,
      [...values, limit]
    );

    const codes = codeRows.map((row) => row.product_code);
    if (!codes.length) {
      return res.json({ summary: { duplicateCodes: 0, duplicateProducts: 0 }, groups: [] });
    }

    const placeholders = codes.map(() => '?').join(',');
    const [rows] = await db.query(
      `SELECT *
       FROM products
       WHERE product_code IN (${placeholders})
       ORDER BY product_code ASC, updated_at DESC, id DESC`,
      codes
    );

    const groups = codes.map((code) => {
      const products = rows.filter((row) => row.product_code === code).map(toProduct);
      return {
        product_code: code,
        item_count: products.length,
        products
      };
    });

    res.json({
      summary: {
        duplicateCodes: groups.length,
        duplicateProducts: groups.reduce((total, group) => total + group.products.length, 0)
      },
      groups
    });
  } catch (err) {
    console.error('Duplicate product-code load failed:', err.message);
    res.status(500).json({ error: 'Unable to load duplicate product codes.' });
  }
});

router.delete('/duplicate-codes/bulk-delete', authenticate, authorize('SERVER', 'ADMIN'), async (req, res) => {
  const barcodes = Array.isArray(req.body?.barcodes)
    ? req.body.barcodes.map((barcode) => String(barcode || '').trim().toUpperCase()).filter(Boolean)
    : [];
  const username = String(req.body?.username || '').trim();
  const password = String(req.body?.password || '');

  if (!barcodes.length) {
    return res.status(400).json({ error: 'Select duplicate products to delete.' });
  }

  if (!username || !password) {
    return res.status(400).json({ error: 'Supervisor username and password are required.' });
  }

  const connection = await db.getConnection();
  try {
    const [userRows] = await connection.query(
      `SELECT id, username, password_hash, role, is_active
       FROM users
       WHERE username = ?
       LIMIT 1`,
      [username]
    );
    const supervisor = userRows[0];
    const allowedRole = ['SERVER', 'ADMIN'].includes(supervisor?.role);
    if (!supervisor || !supervisor.is_active || !allowedRole || !verifyPassword(password, supervisor.password_hash)) {
      return res.status(401).json({ error: 'Supervisor password approval failed.' });
    }

    const placeholders = barcodes.map(() => '?').join(',');
    const [candidateRows] = await connection.query(
      `SELECT barcode, product_code, product_name
       FROM products
       WHERE barcode IN (${placeholders})
         AND product_code IS NOT NULL
         AND TRIM(product_code) <> ''`,
      barcodes
    );

    if (!candidateRows.length) {
      return res.status(400).json({ error: 'Selected duplicate products were not found.' });
    }

    const codes = [...new Set(candidateRows.map((row) => row.product_code))];
    const codePlaceholders = codes.map(() => '?').join(',');
    const [countRows] = await connection.query(
      `SELECT product_code, COUNT(*) AS item_count
       FROM products
       WHERE product_code IN (${codePlaceholders})
       GROUP BY product_code`,
      codes
    );

    const selectedByCode = candidateRows.reduce((acc, row) => {
      acc[row.product_code] = (acc[row.product_code] || 0) + 1;
      return acc;
    }, {});
    const unsafeCode = countRows.find((row) => Number(row.item_count || 0) - Number(selectedByCode[row.product_code] || 0) < 1);

    if (unsafeCode) {
      return res.status(400).json({ error: `Keep at least one product for code ${unsafeCode.product_code}.` });
    }

    const deleteBarcodes = candidateRows.map((row) => row.barcode);
    const deletePlaceholders = deleteBarcodes.map(() => '?').join(',');

    await connection.beginTransaction();
    await connection.query(`DELETE FROM product_batches WHERE barcode IN (${deletePlaceholders})`, deleteBarcodes);
    await connection.query(`DELETE FROM batch_free_offers WHERE trigger_barcode IN (${deletePlaceholders}) OR free_barcode IN (${deletePlaceholders})`, [...deleteBarcodes, ...deleteBarcodes]);
    const [deleteResult] = await connection.query(`DELETE FROM products WHERE barcode IN (${deletePlaceholders})`, deleteBarcodes);

    await writeAuditLog({
      user: req.user,
      action: 'PRODUCT_DUPLICATE_CODE_BULK_DELETED',
      entityType: 'PRODUCT',
      entityId: `${Number(deleteResult?.affectedRows || 0)} products`,
      details: {
        approved_by: supervisor.username,
        requested_count: barcodes.length,
        deleted_count: Number(deleteResult?.affectedRows || 0),
        product_codes: codes,
        barcodes: deleteBarcodes
      },
      connection
    });

    await connection.commit();
    res.json({
      success: true,
      deleted: Number(deleteResult?.affectedRows || 0),
      skipped: barcodes.length - deleteBarcodes.length
    });
  } catch (err) {
    try {
      await connection.rollback();
    } catch (_rollbackErr) {
      // Ignore rollback failure; original error is more useful.
    }
    console.error('Duplicate product-code delete failed:', err.message);
    res.status(500).json({ error: 'Unable to delete duplicate product-code items.' });
  } finally {
    connection.release();
  }
});

router.get('/', authenticate, authorize('SERVER', 'ADMIN', 'COUNTER'), async (req, res) => {
  try {
    const page = Math.max(Number.parseInt(req.query.page, 10) || 1, 1);
    const limit = Math.min(Math.max(Number.parseInt(req.query.limit, 10) || 50, 10), 100);
    const offset = (page - 1) * limit;
    const search = String(req.query.search || '').trim();
    const gst = String(req.query.gst || '').trim();
    const where = [];
    const values = [];

    applyProductSearch(where, values, search);

    if (gst && gst !== 'ALL') {
      where.push('gst_percent = ?');
      values.push(Number(gst));
    }

    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const [countRows] = await db.query(
      `SELECT COUNT(*) AS total FROM products ${whereSql}`,
      values
    );
    const total = Number(countRows[0]?.total || 0);

    const [rows] = await db.query(
      `SELECT *
       FROM products
       ${whereSql}
       ORDER BY product_name ASC, id DESC
       LIMIT ? OFFSET ?`,
      [...values, limit, offset]
    );

    const [summaryRows] = await db.query(
      `SELECT
         COUNT(*) AS total_sku,
         SUM(CASE WHEN stock_qty <= min_stock_alert THEN 1 ELSE 0 END) AS low_stock,
         COALESCE(SUM(stock_qty * purchase_price), 0) AS inventory_value
       FROM products`
    );

    res.json({
      rows: (rows || []).map(toProduct),
      page,
      limit,
      total,
      totalPages: Math.max(Math.ceil(total / limit), 1),
      summary: {
        totalSku: Number(summaryRows[0]?.total_sku || 0),
        lowStock: Number(summaryRows[0]?.low_stock || 0),
        inventoryValue: Number(summaryRows[0]?.inventory_value || 0)
      }
    });
  } catch (err) {
    console.error('Product list failed:', err.message);
    res.status(500).json({ error: 'Unable to fetch product list.' });
  }
});

router.get('/expiry-dashboard', authenticate, authorize('SERVER', 'ADMIN'), async (req, res) => {
  try {
    const days = Math.min(Math.max(Number.parseInt(req.query.days, 10) || 30, 1), 365);
    const limit = Math.min(Math.max(Number.parseInt(req.query.limit, 10) || 500, 50), 1000);
    const [summaryRows] = await db.query(
      `SELECT
         SUM(CASE WHEN pb.expiry_date < CURDATE() THEN 1 ELSE 0 END) AS expired_count,
         SUM(CASE WHEN pb.expiry_date BETWEEN CURDATE() AND DATE_ADD(CURDATE(), INTERVAL ? DAY) THEN 1 ELSE 0 END) AS expiring_count,
         COALESCE(SUM(CASE WHEN pb.expiry_date < CURDATE() THEN pb.quantity_available ELSE 0 END), 0) AS expired_qty,
         COALESCE(SUM(CASE WHEN pb.expiry_date BETWEEN CURDATE() AND DATE_ADD(CURDATE(), INTERVAL ? DAY) THEN pb.quantity_available ELSE 0 END), 0) AS expiring_qty
       FROM product_batches pb
       WHERE pb.expiry_date IS NOT NULL
         AND pb.quantity_available > 0`,
      [days, days]
    );

    const [rows] = await db.query(
      `SELECT pb.barcode,
              p.product_code,
              p.product_name,
              pb.batch_no,
              pb.expiry_date,
              pb.quantity_available,
              pb.mrp,
              pb.purchase_price,
              CASE
                WHEN pb.expiry_date < CURDATE() THEN 'EXPIRED'
                WHEN pb.expiry_date <= DATE_ADD(CURDATE(), INTERVAL 7 DAY) THEN 'EXPIRING_7_DAYS'
                ELSE 'EXPIRING_SOON'
              END AS expiry_status
       FROM product_batches pb
       INNER JOIN products p ON p.barcode = pb.barcode
       WHERE pb.expiry_date IS NOT NULL
         AND pb.quantity_available > 0
         AND pb.expiry_date <= DATE_ADD(CURDATE(), INTERVAL ? DAY)
       ORDER BY pb.expiry_date ASC, p.product_name ASC
       LIMIT ?`,
      [days, limit]
    );

    res.json({
      days,
      summary: {
        expiredCount: Number(summaryRows[0]?.expired_count || 0),
        expiringCount: Number(summaryRows[0]?.expiring_count || 0),
        expiredQty: Number(summaryRows[0]?.expired_qty || 0),
        expiringQty: Number(summaryRows[0]?.expiring_qty || 0)
      },
      rows: (rows || []).map((row) => ({
        ...row,
        quantity_available: Number(row.quantity_available || 0),
        mrp: Number(row.mrp || 0),
        purchase_price: Number(row.purchase_price || 0)
      }))
    });
  } catch (err) {
    console.error('Expiry dashboard failed:', err.message);
    res.status(500).json({ error: 'Unable to load expiry dashboard.' });
  }
});

router.get('/reorder-suggestions', authenticate, authorize('SERVER', 'ADMIN'), async (req, res) => {
  try {
    const limit = Math.min(Math.max(Number.parseInt(req.query.limit, 10) || 500, 50), 1000);
    const [rows] = await db.query(
      `SELECT p.barcode,
              p.product_code,
              p.product_name,
              p.stock_qty,
              p.min_stock_alert,
              p.purchase_unit_type,
              p.purchase_unit_size,
              p.purchase_price,
              p.sale_price,
              COALESCE(sales_30.sold_qty, 0) AS sold_last_30_days,
              GREATEST(CEIL((p.min_stock_alert * 2) - p.stock_qty), 0) AS suggested_qty
       FROM products p
       LEFT JOIN (
         SELECT ii.barcode, SUM(ii.quantity) AS sold_qty
         FROM invoice_items ii
         INNER JOIN invoices i ON i.invoice_no = ii.invoice_no
         WHERE COALESCE(i.invoice_status, 'PAID') <> 'CANCELLED'
           AND i.created_at >= DATE_SUB(CURRENT_TIMESTAMP, INTERVAL 30 DAY)
         GROUP BY ii.barcode
       ) sales_30 ON sales_30.barcode = p.barcode
       WHERE p.stock_qty <= p.min_stock_alert
       ORDER BY (p.stock_qty - p.min_stock_alert) ASC, sold_last_30_days DESC, p.product_name ASC
       LIMIT ?`,
      [limit]
    );

    res.json((rows || []).map((row) => ({
      ...row,
      stock_qty: Number(row.stock_qty || 0),
      min_stock_alert: Number(row.min_stock_alert || 0),
      purchase_unit_size: Number(row.purchase_unit_size || 1),
      purchase_price: Number(row.purchase_price || 0),
      sale_price: Number(row.sale_price || 0),
      sold_last_30_days: Number(row.sold_last_30_days || 0),
      suggested_qty: Number(row.suggested_qty || 0)
    })));
  } catch (err) {
    console.error('Reorder suggestions failed:', err.message);
    res.status(500).json({ error: 'Unable to load reorder suggestions.' });
  }
});

router.post('/stock-adjustments', authenticate, authorize('SERVER', 'ADMIN'), async (req, res) => {
  const barcode = String(req.body?.barcode || '').trim().toUpperCase();
  const adjustmentQty = Number(req.body?.adjustment_qty);
  const reason = String(req.body?.reason || 'OTHER').trim().toUpperCase();
  const note = String(req.body?.note || '').trim();
  const allowedReasons = new Set(['DAMAGE', 'EXPIRY', 'WASTAGE', 'THEFT', 'STOCK_AUDIT', 'OTHER']);

  if (!barcode) return res.status(400).json({ error: 'Barcode is required for stock adjustment.' });
  if (!Number.isFinite(adjustmentQty) || adjustmentQty === 0) return res.status(400).json({ error: 'Enter a non-zero adjustment quantity.' });
  if (!allowedReasons.has(reason)) return res.status(400).json({ error: 'Select a valid stock adjustment reason.' });

  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();
    const [productRows] = await connection.query(
      `SELECT barcode, product_name, stock_qty FROM products WHERE barcode = ? LIMIT 1 FOR UPDATE`,
      [barcode]
    );
    if (!productRows.length) {
      await connection.rollback();
      return res.status(404).json({ error: 'Product not found for this barcode.' });
    }

    const product = productRows[0];
    const oldQty = Number(product.stock_qty || 0);
    const newQty = oldQty + adjustmentQty;
    if (newQty < 0) {
      await connection.rollback();
      return res.status(400).json({ error: `Adjustment cannot make stock negative. Current stock is ${oldQty}.` });
    }

    await connection.query(
      `UPDATE products SET stock_qty = ?, updated_at = CURRENT_TIMESTAMP WHERE barcode = ?`,
      [newQty, barcode]
    );
    const [adjustmentResult] = await connection.query(
      `INSERT INTO stock_adjustments
       (barcode, product_name, old_qty, adjustment_qty, new_qty, reason, note, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [barcode, product.product_name, oldQty, adjustmentQty, newQty, reason, note.slice(0, 255), req.user?.username || '']
    );

    await writeAuditLog({
      user: req.user,
      action: 'PRODUCT_STOCK_ADJUSTED',
      entityType: 'PRODUCT',
      entityId: barcode,
      details: {
        adjustment_id: adjustmentResult.insertId,
        product_name: product.product_name,
        old_qty: oldQty,
        adjustment_qty: adjustmentQty,
        new_qty: newQty,
        reason,
        note
      },
      connection
    });

    await connection.commit();
    res.json({
      success: true,
      adjustmentId: adjustmentResult.insertId,
      barcode,
      product_name: product.product_name,
      old_qty: oldQty,
      adjustment_qty: adjustmentQty,
      new_qty: newQty
    });
  } catch (err) {
    await connection.rollback();
    console.error('Stock adjustment failed:', err.message);
    res.status(500).json({ error: 'Unable to save stock adjustment.' });
  } finally {
    connection.release();
  }
});

router.get('/export/template', authenticate, authorize('SERVER', 'ADMIN'), (_req, res) => {
  const sampleRows = [
    ['73137', '89300296', '(180) JUMBO ROUND KAJU', '', '', '080211', '62.00', '62.00', '0', '2.5', '2.5', '5', '50 Gms', '62.00', '60.00', '10'],
    ['73138', '89300297', '(180) JUMBO ROUND KAJU', '', '', '080211', '120.00', '120.00', '0', '2.5', '2.5', '5', '100 Gms', '120.00', '116.00', '8'],
    ['73139', '89300298', '(180) JUMBO ROUND KAJU', '', '', '080211', '235.00', '235.00', '0', '2.5', '2.5', '5', '200 Gms', '235.00', '226.00', '5'],
    ['73140', '89300299', '(180) JUMBO ROUND KAJU', '', '', '080211', '580.00', '580.00', '0', '2.5', '2.5', '5', '500 Gms', '580.00', '560.00', '3']
  ];

  const tableRows = [
    PRODUCT_CSV_HEADERS,
    ...sampleRows
  ].map((row, rowIndex) => (
    `<tr>${row.map((cell) => `<${rowIndex === 0 ? 'th' : 'td'}>${csvEscape(cell)}</${rowIndex === 0 ? 'th' : 'td'}>`).join('')}</tr>`
  )).join('');

  const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <style>
    table { border-collapse: collapse; font-family: Calibri, Arial, sans-serif; font-size: 12pt; }
    th { background: #d9f2d0; font-weight: bold; }
    th, td { border: 1px solid #000; padding: 4px 8px; mso-number-format:"\\@"; }
  </style>
</head>
<body>
  <table>${tableRows}</table>
</body>
</html>`;

  res.setHeader('Content-Type', 'application/vnd.ms-excel; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="badizo_product_import_sample.xls"');
  res.send(html);
});

router.get('/export', authenticate, authorize('SERVER', 'ADMIN'), async (_req, res) => {
  try {
    const [rows] = await db.query(`SELECT * FROM products ORDER BY product_name ASC`);
    const csv = [
      csvLine(PRODUCT_EXPORT_HEADERS),
      ...rows.map((row) => csvLine(PRODUCT_EXPORT_HEADERS.map((header) => {
        if (header === 'is_free_item') return row.is_free_item ? '1' : '0';
        return row[header];
      })))
    ].join('\n');

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="badizo_products_export.csv"');
    res.send(csv);
  } catch (err) {
    console.error('Product export failed:', err.message);
    res.status(500).json({ error: 'Unable to export products.' });
  }
});

function buildImportSummary({ totalInputRows, inserted, updated, taxSynced = 0, batches, batchSize = PRODUCT_IMPORT_BATCH_SIZE, errors }) {
  return {
    totalRows: totalInputRows,
    validRows: inserted + updated,
    inserted,
    updated,
    taxSynced,
    batches,
    batchSize,
    skipped: errors.length,
    errorRows: errors.length,
    errors: errors.slice(0, 100)
  };
}

async function fetchExistingImportProducts(connection, batch) {
  const barcodes = [...new Set(batch.map((product) => product.barcode).filter(Boolean))];
  const productCodes = [...new Set(batch.map((product) => product.product_code).filter(Boolean))];
  const clauses = [];
  const values = [];

  if (barcodes.length) {
    clauses.push(`barcode IN (${barcodes.map(() => '?').join(',')})`);
    values.push(...barcodes);
  }

  if (productCodes.length) {
    clauses.push(`product_code IN (${productCodes.map(() => '?').join(',')})`);
    values.push(...productCodes);
  }

  if (!clauses.length) {
    return { byBarcode: new Map(), byCode: new Map() };
  }

  const [rows] = await connection.query(
    `SELECT *
     FROM products
     WHERE ${clauses.join(' OR ')}`,
    values
  );

  const byBarcode = new Map();
  const byCode = new Map();
  (rows || []).forEach((row) => {
    if (row.barcode) byBarcode.set(row.barcode, row);
    if (row.product_code) byCode.set(row.product_code, row);
  });
  return { byBarcode, byCode };
}

function existingImportProduct(existingProducts, product) {
  return existingProducts.byBarcode.get(product.barcode)
    || (product.product_code ? existingProducts.byCode.get(product.product_code) : null)
    || null;
}

async function fetchExistingImportProductsFromDb(products) {
  const existingProducts = { byBarcode: new Map(), byCode: new Map() };
  for (let index = 0; index < products.length; index += PRODUCT_IMPORT_BATCH_SIZE) {
    const batch = products.slice(index, index + PRODUCT_IMPORT_BATCH_SIZE);
    const batchExisting = await fetchExistingImportProducts(db, batch);
    batchExisting.byBarcode.forEach((value, key) => existingProducts.byBarcode.set(key, value));
    batchExisting.byCode.forEach((value, key) => existingProducts.byCode.set(key, value));
  }
  return existingProducts;
}

function rememberImportedProduct(existingProducts, product) {
  if (!product?.barcode) return;
  const snapshot = productSnapshot(product);
  existingProducts.byBarcode.set(product.barcode, snapshot);
  if (product.product_code) existingProducts.byCode.set(product.product_code, snapshot);
}

function requiredImportErrorsForNewProduct(product) {
  const errors = [];
  const hasAnyGst = product.import_fields?.gst_percent
    || product.import_fields?.sales_sgst_percent
    || product.import_fields?.sales_cgst_percent
    || product.import_fields?.sales_igst_percent;

  if (!product.product_name) errors.push('Product name is required for new barcode');
  if (!hasAnyGst) errors.push('GST is required for new barcode');
  if (!product.import_fields?.mrp) errors.push('MRP is required for new barcode');
  if (!product.import_fields?.sale_price) errors.push('Sales Rate is required for new barcode');
  return errors;
}

async function resolveImportProductsAgainstExisting(products, errors) {
  if (!products.length) return;
  const existingProducts = await fetchExistingImportProductsFromDb(products);
  const validProducts = [];

  for (const product of products) {
    const existingProduct = existingImportProduct(existingProducts, product);
    if (existingProduct) {
      if (!product.import_fields?.product_name) {
        product.product_name = existingProduct.product_name;
      }
      product.product_code = existingProduct.product_code;
      validProducts.push(product);
      continue;
    }

    const requiredErrors = requiredImportErrorsForNewProduct(product);
    if (requiredErrors.length) {
      const message = `Barcode ${product.barcode} was not found in products. ${requiredErrors.join(', ')}. Add the product name/details for a new product, or correct the barcode.`;
      errors.push({
        row: product.source_row,
        product_code: product.product_code || '',
        barcode: product.barcode,
        product_name: product.product_name || '',
        errors: [message],
        message,
        rawValues: {
          product_code: product.product_code || '',
          barcode: product.barcode,
          description: product.product_name || ''
        }
      });
      continue;
    }

    validProducts.push(product);
  }

  products.length = 0;
  products.push(...validProducts);
}

function productImportValues(product) {
  return PRODUCT_IMPORT_COLUMNS.map((column) => product[column]);
}

function productForImportWrite(product, existingProduct) {
  if (!existingProduct) {
    return {
      ...product,
      stock_qty: product.import_fields?.stock_qty ? product.stock_qty : 0
    };
  }

  const merged = {
    ...product,
    barcode: existingProduct.barcode
  };

  PRODUCT_IMPORT_COLUMNS.forEach((column) => {
    if (column === 'barcode') return;
    if (column === 'stock_qty') {
      merged.stock_qty = product.import_fields?.stock_qty
        ? Number(existingProduct.stock_qty || 0) + Number(product.stock_qty || 0)
        : Number(existingProduct.stock_qty || 0);
      return;
    }
    if (!product.import_fields?.[column]) {
      merged[column] = existingProduct[column];
    }
  });

  merged.product_code = existingProduct.product_code;

  return merged;
}

async function bulkUpsertProducts(connection, products = []) {
  if (!products.length) return;

  const placeholders = products
    .map(() => `(${PRODUCT_IMPORT_COLUMNS.map(() => '?').join(',')})`)
    .join(',');
  const values = products.flatMap(productImportValues);
  const updateSql = PRODUCT_IMPORT_COLUMNS
    .filter((column) => column !== 'barcode')
    .map((column) => `${column} = VALUES(${column})`)
    .join(',\n                 ');

  await connection.query(
    `INSERT INTO products
     (${PRODUCT_IMPORT_COLUMNS.join(', ')})
     VALUES ${placeholders}
     ON DUPLICATE KEY UPDATE
       ${updateSql}`,
    values
  );
}

function prepareImportBatch(batch, existingProducts) {
  let inserted = 0;
  let updated = 0;
  const productsForWrite = [];
  const historyLines = [];

  for (const product of batch) {
    const existingProduct = existingImportProduct(existingProducts, product);
    const existed = Boolean(existingProduct);
    const previousProduct = existed ? productSnapshot(existingProduct) : null;
    const productForWrite = productForImportWrite(product, existingProduct);

    if (existed) updated += 1;
    else inserted += 1;

    productsForWrite.push(productForWrite);
    historyLines.push({
      row_no: product.source_row,
      product_code: productForWrite.product_code,
      barcode: productForWrite.barcode,
      product_name: productForWrite.product_name,
      action_status: existed ? 'UPDATED' : 'INSERTED',
      previous_product_json: previousProduct,
      imported_product_json: productSnapshot(productForWrite)
    });
  }

  return { inserted, updated, productsForWrite, historyLines };
}

function removeDuplicateProductsWithinImport(products, errors) {
  const seenBarcodes = new Set();
  const seenProductCodes = new Set();
  const uniqueProducts = [];

  for (const product of products) {
    if (seenBarcodes.has(product.barcode)) {
      errors.push({
        row: product.source_row,
        product_code: product.product_code || '',
        barcode: product.barcode,
        product_name: product.product_name || '',
        errors: [`Duplicate barcode ${product.barcode} repeated in this import file`],
        message: `Skipped: Duplicate barcode ${product.barcode} repeated in this import file. Keep only one row per product.`
      });
      continue;
    }

    if (product.product_code && seenProductCodes.has(product.product_code)) {
      errors.push({
        row: product.source_row,
        product_code: product.product_code,
        barcode: product.barcode || '',
        product_name: product.product_name || '',
        errors: [`Duplicate product code ${product.product_code} repeated in this import file`],
        message: `Skipped: Duplicate product code ${product.product_code} repeated in this import file. Keep only one row per product code.`
      });
      continue;
    }

    seenBarcodes.add(product.barcode);
    if (product.product_code) seenProductCodes.add(product.product_code);
    uniqueProducts.push(product);
  }

  products.length = 0;
  products.push(...uniqueProducts);
}

async function processImportBatchRowByRow(connection, { importId, batch, existingProducts, shouldSyncTaxByName }) {
  let inserted = 0;
  let updated = 0;
  let taxSynced = 0;
  const errors = [];

  for (const product of batch) {
    let productForWrite = product;
    let savepointCreated = false;
    try {
      await connection.query('SAVEPOINT product_import_row');
      savepointCreated = true;

      const existingProduct = existingImportProduct(existingProducts, product);
      const existed = Boolean(existingProduct);
      const previousProduct = existed ? productSnapshot(existingProduct) : null;
      productForWrite = productForImportWrite(product, existingProduct);

      await bulkUpsertProducts(connection, [productForWrite]);

      if (existed) updated += 1;
      else inserted += 1;

      await insertProductImportLine(connection, importId, {
        row_no: product.source_row,
        product_code: productForWrite.product_code,
        barcode: productForWrite.barcode,
        product_name: productForWrite.product_name,
        action_status: existed ? 'UPDATED' : 'INSERTED',
        previous_product_json: previousProduct,
        imported_product_json: productSnapshot(productForWrite)
      });

      if (shouldSyncTaxByName) {
        taxSynced += await syncProductTaxByName(connection, {
          productName: product.product_name,
          aliasNames: product.alias_names,
          hsnCode: product.hsn_code,
          gstPercent: product.gst_percent
        });
      }

      rememberImportedProduct(existingProducts, productForWrite);
      await connection.query('RELEASE SAVEPOINT product_import_row');
      savepointCreated = false;
    } catch (rowErr) {
      if (savepointCreated) {
        try {
          await connection.query('ROLLBACK TO SAVEPOINT product_import_row');
        } catch (rollbackErr) {
          console.error('Product import row rollback failed:', rollbackErr.message);
        }

        try {
          await connection.query('RELEASE SAVEPOINT product_import_row');
        } catch (_releaseErr) {
          // The savepoint may already be gone after a rollback or connection-level error.
        }
      }

      const rowMessage = formatProductImportDbError(product, rowErr);
      errors.push({
        row: product.source_row,
        product_code: product.product_code || '',
        barcode: productForWrite?.barcode || product.barcode,
        product_name: product.product_name,
        errors: [rowMessage],
        message: rowMessage,
        logged: true
      });
      await insertProductImportLine(connection, importId, {
        row_no: product.source_row,
        product_code: product.product_code,
        barcode: product.barcode,
        product_name: product.product_name,
        action_status: 'ERROR',
        error_message: rowMessage,
        imported_product_json: productSnapshot(product)
      });
    }
  }

  return { inserted, updated, taxSynced, errors };
}

async function processProductImportJob({ importId, totalInputRows, products, errors: initialErrors = [] }) {
  let inserted = 0;
  let updated = 0;
  let taxSynced = 0;
  let batches = 0;
  const errors = initialErrors.map((rowError) => ({ ...rowError }));
  const shouldSyncTaxByName = products.length <= PRODUCT_IMPORT_TAX_SYNC_LIMIT;

  try {
    const startConnection = await db.getConnection();
    try {
      await startConnection.beginTransaction();
      for (const rowError of errors) {
        await insertProductImportLine(startConnection, importId, {
          row_no: rowError.row,
          product_code: rowError.product_code,
          barcode: rowError.barcode,
          product_name: rowError.product_name,
          action_status: 'ERROR',
          error_message: rowError.message || rowError.errors.join(', ')
        });
        rowError.logged = true;
      }
      await updateProductImportProgress(startConnection, importId, {
        totalRows: totalInputRows,
        validRows: 0,
        inserted,
        updated,
        errorRows: errors.length,
        skipped: errors.length,
        batches
      });
      await startConnection.commit();
    } catch (err) {
      await startConnection.rollback();
      throw err;
    } finally {
      startConnection.release();
    }

    for (let index = 0; index < products.length; index += PRODUCT_IMPORT_BATCH_SIZE) {
      const batch = products.slice(index, index + PRODUCT_IMPORT_BATCH_SIZE);
      const connection = await db.getConnection();
      batches += 1;

      try {
        await connection.beginTransaction();
        const existingProducts = await fetchExistingImportProducts(connection, batch);
        const preparedBatch = prepareImportBatch(batch, existingProducts);

        try {
          await bulkUpsertProducts(connection, preparedBatch.productsForWrite);
          await insertProductImportLines(connection, importId, preparedBatch.historyLines);

          if (shouldSyncTaxByName) {
            for (const product of batch) {
              taxSynced += await syncProductTaxByName(connection, {
                productName: product.product_name,
                aliasNames: product.alias_names,
                hsnCode: product.hsn_code,
                gstPercent: product.gst_percent
              });
            }
          }

          preparedBatch.productsForWrite.forEach((product) => rememberImportedProduct(existingProducts, product));
          inserted += preparedBatch.inserted;
          updated += preparedBatch.updated;
        } catch (bulkErr) {
          console.error(`Product import bulk batch ${batches} fell back to row mode:`, bulkErr.message);
          await connection.rollback();
          await connection.beginTransaction();

          const fallbackExistingProducts = await fetchExistingImportProducts(connection, batch);
          const fallbackResult = await processImportBatchRowByRow(connection, {
            importId,
            batch,
            existingProducts: fallbackExistingProducts,
            shouldSyncTaxByName
          });
          inserted += fallbackResult.inserted;
          updated += fallbackResult.updated;
          taxSynced += fallbackResult.taxSynced;
          errors.push(...fallbackResult.errors);
        }

        await updateProductImportProgress(connection, importId, {
          totalRows: totalInputRows,
          validRows: inserted + updated,
          inserted,
          updated,
          errorRows: errors.length,
          skipped: errors.length,
          batches
        });
        await connection.commit();
      } catch (err) {
        await connection.rollback();
        throw err;
      } finally {
        connection.release();
      }
    }

    const summary = buildImportSummary({
      totalInputRows,
      inserted,
      updated,
      taxSynced,
      batches,
      errors
    });

    const connection = await db.getConnection();
    try {
      await connection.beginTransaction();
      for (const rowError of errors) {
        if (rowError.logged) continue;
        await insertProductImportLine(connection, importId, {
          row_no: rowError.row,
          product_code: rowError.product_code,
          barcode: rowError.barcode,
          product_name: rowError.product_name,
          action_status: 'ERROR',
          error_message: rowError.message || rowError.errors.join(', ')
        });
      }
      await updateProductImportJob(connection, importId, summary);
      await connection.commit();
    } catch (err) {
      await connection.rollback();
      throw err;
    } finally {
      connection.release();
    }
  } catch (err) {
    console.error('Product import failed:', err.message);
    logError('Product import failed', err, {
      importId,
      totalInputRows,
      inserted,
      updated,
      batches,
      errors: errors.length
    });
    try {
      const connection = await db.getConnection();
      try {
        await connection.beginTransaction();
        await updateProductImportJob(connection, importId, {
          totalRows: totalInputRows,
          validRows: inserted + updated,
          inserted,
          updated,
          errorRows: Math.max(errors.length, 1),
          skipped: errors.length,
          batches
        }, err.message, 'FAILED');
        await insertProductImportLine(connection, importId, {
          row_no: 0,
          action_status: 'ERROR',
          error_message: `Import failed before completion: ${err.message}`
        });
        await connection.commit();
      } catch (historyErr) {
        await connection.rollback();
      } finally {
        connection.release();
      }
    } catch (_historyErr) {
      // Import failure logging should never crash the API process.
    }
  }
}

router.post('/import', authenticate, authorize('SERVER', 'ADMIN'), async (req, res) => {
  const csvText = String(req.body?.csv || '');
  const fileName = String(req.body?.fileName || req.body?.filename || '');

  if (!csvText.trim()) {
    return res.status(400).json({ error: 'CSV file content is required.' });
  }

  const parsedRows = parseCsv(csvText);
  if (parsedRows.length < 2) {
    const importId = await createProductImportJob({ fileName, user: req.user, totalRows: Math.max(parsedRows.length - 1, 0) });
    const connection = await db.getConnection();
    try {
      await connection.beginTransaction();
      await updateProductImportJob(connection, importId, {
        totalRows: Math.max(parsedRows.length - 1, 0),
        validRows: 0,
        inserted: 0,
        updated: 0,
        errorRows: 1,
        skipped: 1,
        batches: 0
      }, 'CSV must include header and at least one product row.');
      await connection.commit();
    } catch (err) {
      await connection.rollback();
    } finally {
      connection.release();
    }
    return res.status(400).json({ error: 'CSV must include header and at least one product row.', importId });
  }

  const headers = mapImportHeaders(parsedRows[0]);
  const totalInputRows = parsedRows.length - 1;
  const importId = await createProductImportJob({ fileName, user: req.user, totalRows: totalInputRows });
  const hasProductCode = headers.includes('product_code') || headers.includes('barcode');
  const missingHeaders = [
    ...(!hasProductCode ? ['Product Code'] : [])
  ];
  if (missingHeaders.length) {
    const connection = await db.getConnection();
    const error = `Missing required columns: ${missingHeaders.join(', ')}`;
    try {
      await connection.beginTransaction();
      await insertProductImportLine(connection, importId, {
        row_no: 1,
        action_status: 'ERROR',
        error_message: error
      });
      await updateProductImportJob(connection, importId, {
        totalRows: totalInputRows,
        validRows: 0,
        inserted: 0,
        updated: 0,
        errorRows: 1,
        skipped: totalInputRows,
        batches: 0
      }, error);
      await connection.commit();
    } catch (err) {
      await connection.rollback();
    } finally {
      connection.release();
    }
    return res.status(400).json({ error, importId });
  }

  const errors = [];
  const products = [];

  parsedRows.slice(1).forEach((row, index) => {
    const rawRow = headers.reduce((acc, header, headerIndex) => {
      acc[header] = row[headerIndex] || '';
      return acc;
    }, {});

    const hasProductIdentity = String(rawRow.product_code || rawRow.barcode || rawRow.product_name || '').trim();
    if (!hasProductIdentity) return;

    const normalized = normalizeCsvRow(rawRow, index + 2);

    if (normalized.errors.length) {
      errors.push({
        row: normalized.rowNumber,
        product_code: normalized.product.product_code || '',
        barcode: normalized.product.barcode,
        product_name: normalized.product.product_name || normalizeProductName(rawRow.product_name),
        errors: normalized.errors,
        rawValues: normalized.rawValues,
        message: importErrorMessage(normalized.errors, normalized.rawValues)
      });
    } else {
      products.push(normalized.product);
    }
  });

  await resolveImportProductsAgainstExisting(products, errors);

  const productCodes = [...new Set(products.map((product) => product.product_code).filter(Boolean))];
  if (productCodes.length) {
    const conflictingRows = [];
    for (let index = 0; index < productCodes.length; index += PRODUCT_IMPORT_BATCH_SIZE) {
      const batchCodes = productCodes.slice(index, index + PRODUCT_IMPORT_BATCH_SIZE);
      const placeholders = batchCodes.map(() => '?').join(',');
      const [rows] = await db.query(
        `SELECT product_code, barcode FROM products WHERE product_code IN (${placeholders})`,
        batchCodes
      );
      conflictingRows.push(...rows);
    }

    const existingByCode = new Map(conflictingRows.map((row) => [row.product_code, row.barcode]));
    const conflicts = products
      .filter((product) => existingByCode.has(product.product_code) && existingByCode.get(product.product_code) !== product.barcode)
      .map((product) => {
        const existingBarcode = existingByCode.get(product.product_code);
        return {
          row: product.source_row || '-',
          product_code: product.product_code,
          barcode: product.barcode || '',
          product_name: product.product_name || '',
          errors: [`Product code ${product.product_code} already belongs to barcode ${existingBarcode}`],
          message: `Skipped: Product code ${product.product_code} already belongs to barcode ${existingBarcode}. This row has barcode ${product.barcode || '-'} and was not imported.`
        };
      });

    if (conflicts.length) {
      const conflictRows = new Set(conflicts.map((row) => `${row.row}:${row.product_code}:${row.barcode}`));
      errors.push(...conflicts);
      for (let index = products.length - 1; index >= 0; index -= 1) {
        const key = `${products[index].source_row}:${products[index].product_code}:${products[index].barcode}`;
        if (conflictRows.has(key)) products.splice(index, 1);
      }
    }
  }

  removeDuplicateProductsWithinImport(products, errors);

  if (!products.length) {
    const connection = await db.getConnection();
    try {
      await connection.beginTransaction();
      for (const rowError of errors) {
        await insertProductImportLine(connection, importId, {
          row_no: rowError.row,
          product_code: rowError.product_code,
          barcode: rowError.barcode,
          product_name: rowError.product_name,
          action_status: 'ERROR',
          error_message: rowError.message || rowError.errors.join(', ')
        });
      }
      await updateProductImportJob(connection, importId, {
        totalRows: totalInputRows,
        validRows: 0,
        inserted: 0,
        updated: 0,
        errorRows: errors.length,
        skipped: errors.length,
        batches: 0
      }, 'CSV validation failed. No valid rows to import.');
      await connection.commit();
    } catch (err) {
      await connection.rollback();
    } finally {
      connection.release();
    }
    return res.status(400).json({
      error: 'CSV validation failed. No valid rows to import.',
      importId,
      summary: {
        totalRows: totalInputRows,
        validRows: 0,
        errorRows: errors.length,
        inserted: 0,
        updated: 0,
        skipped: errors.length
      },
      errors: errors.slice(0, 100),
      warnings: errors.slice(0, 100)
    });
  }

  setImmediate(() => {
    processProductImportJob({ importId, totalInputRows, products, errors }).catch((err) => {
      console.error('Product import background job failed:', err.message);
      logError('Product import background job failed', err, {
        importId,
        fileName,
        totalRows: totalInputRows,
        user: req.user?.username || ''
      });
    });
  });

  return res.status(202).json({
    success: true,
    queued: true,
    status: 'QUEUED',
    importId,
    message: 'Product import started. Track the live status in Import History.',
    summary: {
      totalRows: totalInputRows,
      acceptedRows: products.length,
      validRows: 0,
      inserted: 0,
      updated: 0,
      skipped: errors.length,
      errorRows: errors.length,
      batches: Math.ceil(products.length / PRODUCT_IMPORT_BATCH_SIZE),
      batchSize: PRODUCT_IMPORT_BATCH_SIZE,
      errors: errors.slice(0, 100)
    },
    warnings: errors.slice(0, 100)
  });
});

function parseJsonValue(value) {
  if (!value) return null;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch (_err) {
    return null;
  }
}

async function restoreProductSnapshot(connection, snapshot) {
  await connection.query(
    `INSERT INTO products
     (product_code, barcode, product_name, alias_names, hsn_code, gst_percent, sales_sgst_percent, sales_cgst_percent, sales_igst_percent,
      unit_type, purchase_unit_type, purchase_unit_size, mrp, purchase_price, sale_price, wholesale_price,
      discount_type, discount_value, bulk_discount_value, is_free_item, free_promo_enabled, free_promo_name, free_promo_qty_per_sale,
      free_promo_total_qty, free_promo_remaining_qty, stock_qty, min_stock_alert)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       product_code = VALUES(product_code),
       product_name = VALUES(product_name),
       alias_names = VALUES(alias_names),
       hsn_code = VALUES(hsn_code),
       gst_percent = VALUES(gst_percent),
       sales_sgst_percent = VALUES(sales_sgst_percent),
       sales_cgst_percent = VALUES(sales_cgst_percent),
       sales_igst_percent = VALUES(sales_igst_percent),
       unit_type = VALUES(unit_type),
       purchase_unit_type = VALUES(purchase_unit_type),
       purchase_unit_size = VALUES(purchase_unit_size),
       mrp = VALUES(mrp),
       purchase_price = VALUES(purchase_price),
       sale_price = VALUES(sale_price),
       wholesale_price = VALUES(wholesale_price),
       discount_type = VALUES(discount_type),
       discount_value = VALUES(discount_value),
       bulk_discount_value = VALUES(bulk_discount_value),
       is_free_item = VALUES(is_free_item),
       free_promo_enabled = VALUES(free_promo_enabled),
       free_promo_name = VALUES(free_promo_name),
       free_promo_qty_per_sale = VALUES(free_promo_qty_per_sale),
       free_promo_total_qty = VALUES(free_promo_total_qty),
       free_promo_remaining_qty = VALUES(free_promo_remaining_qty),
       stock_qty = VALUES(stock_qty),
       min_stock_alert = VALUES(min_stock_alert)`,
    [
      snapshot.product_code,
      snapshot.barcode,
      snapshot.product_name,
      snapshot.alias_names,
      snapshot.hsn_code,
      snapshot.gst_percent,
      snapshot.sales_sgst_percent,
      snapshot.sales_cgst_percent,
      snapshot.sales_igst_percent,
      snapshot.unit_type,
      snapshot.purchase_unit_type,
      snapshot.purchase_unit_size,
      snapshot.mrp,
      snapshot.purchase_price,
      snapshot.sale_price,
      snapshot.wholesale_price,
      snapshot.discount_type,
      snapshot.discount_value,
      snapshot.bulk_discount_value,
      snapshot.is_free_item,
      snapshot.free_promo_enabled,
      snapshot.free_promo_name,
      snapshot.free_promo_qty_per_sale,
      snapshot.free_promo_total_qty,
      snapshot.free_promo_remaining_qty,
      snapshot.stock_qty,
      snapshot.min_stock_alert
    ]
  );
}

router.get('/import-history', authenticate, authorize('SERVER', 'ADMIN'), async (req, res) => {
  try {
    const limit = Math.min(Math.max(Number.parseInt(req.query.limit, 10) || 100, 10), 500);
    const [rows] = await db.query(
      `SELECT *
       FROM product_import_jobs
       ORDER BY created_at DESC
       LIMIT ?`,
      [limit]
    );
    res.json((rows || []).map((row) => ({
      id: row.id,
      file_name: row.file_name || '',
      status: row.status,
      total_rows: Number(row.total_rows || 0),
      valid_rows: Number(row.valid_rows || 0),
      inserted_count: Number(row.inserted_count || 0),
      updated_count: Number(row.updated_count || 0),
      error_rows: Number(row.error_rows || 0),
      skipped_count: Number(row.skipped_count || 0),
      batch_count: Number(row.batch_count || 0),
      failure_message: row.failure_message || '',
      rollback_status: row.rollback_status || 'ACTIVE',
      rollback_at: row.rollback_at,
      rollback_by: row.rollback_by || '',
      created_by: row.created_by || '',
      created_at: row.created_at,
      updated_at: row.updated_at
    })));
  } catch (err) {
    console.error('Product import history load failed:', err.message);
    res.status(500).json({ error: 'Unable to load product import history.' });
  }
});

router.get('/import-history/:id', authenticate, authorize('SERVER', 'ADMIN'), async (req, res) => {
  try {
    const importId = String(req.params.id || '').trim();
    const [jobRows] = await db.query(`SELECT * FROM product_import_jobs WHERE id = ? LIMIT 1`, [importId]);
    if (!jobRows.length) return res.status(404).json({ error: 'Import history item not found.' });

    const [lineRows] = await db.query(
      `SELECT id, row_no, product_code, barcode, product_name, action_status, error_message, created_at
       FROM product_import_lines
       WHERE import_id = ?
       ORDER BY row_no ASC, id ASC
       LIMIT ?`,
      [importId, PRODUCT_IMPORT_LINE_LIMIT]
    );

    res.json({
      job: jobRows[0],
      lines: lineRows || []
    });
  } catch (err) {
    console.error('Product import history detail failed:', err.message);
    res.status(500).json({ error: 'Unable to load product import details.' });
  }
});

router.delete('/import-history/:id', authenticate, authorize('SERVER', 'ADMIN'), async (req, res) => {
  const importId = String(req.params.id || '').trim();
  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();
    const [jobRows] = await connection.query(`SELECT * FROM product_import_jobs WHERE id = ? LIMIT 1 FOR UPDATE`, [importId]);
    const job = jobRows[0];
    if (!job) {
      await connection.rollback();
      return res.status(404).json({ error: 'Import history item not found.' });
    }
    if (job.rollback_status === 'ROLLED_BACK') {
      await connection.rollback();
      return res.status(400).json({ error: 'This import was already deleted/rolled back.' });
    }
    if (PRODUCT_IMPORT_ACTIVE_STATUSES.has(job.status)) {
      await connection.rollback();
      return res.status(400).json({ error: 'This import is still running. Delete/rollback is available after it completes.' });
    }

    const [lineRows] = await connection.query(
      `SELECT *
       FROM product_import_lines
       WHERE import_id = ? AND action_status IN ('INSERTED', 'UPDATED')
       ORDER BY id DESC`,
      [importId]
    );

    let deletedProducts = 0;
    let restoredProducts = 0;
    for (const line of lineRows) {
      if (line.action_status === 'INSERTED') {
        await connection.query(`DELETE FROM product_batches WHERE barcode = ?`, [line.barcode]);
        await connection.query(`DELETE FROM batch_free_offers WHERE trigger_barcode = ? OR free_barcode = ?`, [line.barcode, line.barcode]);
        const [deleteResult] = await connection.query(`DELETE FROM products WHERE barcode = ?`, [line.barcode]);
        deletedProducts += Number(deleteResult?.affectedRows || 0);
      } else if (line.action_status === 'UPDATED') {
        const previous = parseJsonValue(line.previous_product_json);
        if (previous?.barcode) {
          await restoreProductSnapshot(connection, previous);
          restoredProducts += 1;
        }
      }
    }

    await connection.query(
      `UPDATE product_import_lines
       SET action_status = 'ROLLED_BACK'
       WHERE import_id = ? AND action_status IN ('INSERTED', 'UPDATED')`,
      [importId]
    );
    await connection.query(
      `UPDATE product_import_jobs
       SET status = 'ROLLED BACK',
           rollback_status = 'ROLLED_BACK',
           rollback_at = CURRENT_TIMESTAMP,
           rollback_by = ?
       WHERE id = ?`,
      [req.user?.username || '', importId]
    );

    await writeAuditLog({
      user: req.user,
      action: 'PRODUCT_IMPORT_ROLLED_BACK',
      entityType: 'PRODUCT_IMPORT',
      entityId: importId,
      details: {
        deleted_products: deletedProducts,
        restored_products: restoredProducts
      },
      connection
    });

    await connection.commit();
    res.json({ success: true, deletedProducts, restoredProducts });
  } catch (err) {
    try {
      await connection.rollback();
    } catch (_rollbackErr) {
      // Ignore rollback failure.
    }
    console.error('Product import rollback failed:', err.message);
    res.status(500).json({ error: 'Unable to delete/rollback product import.' });
  } finally {
    connection.release();
  }
});

router.get('/bulk-edit/search', authenticate, authorize('SERVER', 'ADMIN'), async (req, res) => {
  try {
    const search = String(req.query.search || '').trim();
    if (search.length < 3) {
      return res.json([]);
    }

    const where = [];
    const values = [];
    applyProductSearch(where, values, search);
    const [rows] = await db.query(
      `SELECT id, barcode, product_name, alias_names, hsn_code, gst_percent, unit_type
       FROM products
       WHERE ${where.join(' AND ')}
       ORDER BY product_name ASC, id DESC
       LIMIT 500`,
      values
    );

    res.json((rows || []).map((row) => ({
      id: row.id,
      barcode: row.barcode,
      product_name: row.product_name,
      alias_names: row.alias_names || '',
      hsn_code: row.hsn_code || '',
      gst_percent: Number(row.gst_percent || 0),
      unit_type: row.unit_type || 'Nos'
    })));
  } catch (err) {
    console.error('Product bulk search failed:', err.message);
    res.status(500).json({ error: 'Unable to fetch products for bulk edit.' });
  }
});

router.get('/search/:query', authenticate, authorize('SERVER', 'ADMIN', 'COUNTER'), async (req, res) => {
  try {
    const q = decodeURIComponent(req.params.query || '').trim();

    if (!q) {
      return res.status(400).json({ error: 'Search query is required.' });
    }

    if (q === '%') {
      const [rows] = await db.query(
        `SELECT * FROM products ORDER BY product_name ASC, id DESC LIMIT 500`
      );
      return res.json((rows || []).map(toProduct));
    }

    const [exactRows] = await db.query(
      `SELECT * FROM products
       WHERE barcode = ? OR product_code = ?
       ORDER BY product_name ASC
       LIMIT 5`,
      [q.toUpperCase(), q.toUpperCase()]
    );

    if (exactRows && exactRows.length > 0) {
      return res.json(exactRows.map(toProduct));
    }

    if (q.length >= 3) {
      const where = [];
      const values = [];
      applyProductSearch(where, values, q);
      const [rows] = await db.query(
        `SELECT * FROM products
         WHERE ${where.join(' AND ')}
         ORDER BY product_name ASC
         LIMIT 5`,
        values
      );
      return res.json((rows || []).map(toProduct));
    }

    return res.status(404).json({ error: 'Product not found.' });
  } catch (err) {
    console.error('Product search failed:', err.message);
    res.status(500).json({ error: 'Unable to fetch products from database.' });
  }
});

router.get('/exact/:query', authenticate, authorize('SERVER', 'ADMIN', 'COUNTER'), async (req, res) => {
  try {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    const q = decodeURIComponent(req.params.query || '').trim().toUpperCase();
    if (!q) return res.status(400).json({ error: 'Barcode or product code is required.' });

    const [barcodeRows] = await db.query(
      `SELECT * FROM products WHERE barcode = ? LIMIT 1`,
      [q]
    );
    if (barcodeRows.length) return res.json(toProduct(barcodeRows[0]));

    const [codeRows] = await db.query(
      `SELECT * FROM products WHERE product_code = ? LIMIT 1`,
      [q]
    );
    if (codeRows.length) return res.json(toProduct(codeRows[0]));

    return res.status(404).json({ error: 'Product not found.' });
  } catch (err) {
    console.error('Exact product lookup failed:', err.message);
    res.status(500).json({ error: 'Unable to lookup product barcode.' });
  }
});

router.post('/save', authenticate, authorize('SERVER', 'ADMIN'), async (req, res) => {
  const {
    barcode,
    product_code,
    code_mode,
    product_name,
    alias_names,
    hsn_code,
    gst_percent,
    unit_type,
    purchase_unit_type,
    purchase_unit_size,
    mrp,
    purchase_price,
    sale_price,
    wholesale_price,
    discount_type,
    discount_value,
    bulk_discount_value,
    is_free_item,
    free_promo_enabled,
    free_promo_name,
    free_promo_qty_per_sale,
    free_promo_total_qty,
    stock_qty,
    min_stock_alert
  } = req.body;

  if (!barcode || !product_name) {
    return res.status(400).json({ error: 'Barcode and product name are required.' });
  }

  try {
    const values = {
      hsnCode: hsn_code || '',
      gstPercent: Number(gst_percent),
      unitType: normalizeUnitType(unit_type),
      purchaseUnitType: normalizePurchaseUnitType(purchase_unit_type),
      purchaseUnitSize: Math.max(Number(purchase_unit_size) || 1, 0.001),
      mrp: Number(mrp) || 0,
      purchasePrice: Number(purchase_price) || 0,
      productName: normalizeProductName(product_name),
      aliasNames: normalizeAliasNames(alias_names),
      salePrice: Number(sale_price) || 0,
      wholesalePrice: Number(wholesale_price || sale_price) || 0,
      discountType: discount_type === 'VALUE' ? 'VALUE' : 'PERCENT',
      discountValue: Number(discount_value) || 0,
      bulkDiscountValue: Number(bulk_discount_value) || 0,
      isFreeItem: is_free_item ? 1 : 0,
      freePromoEnabled: free_promo_enabled ? 1 : 0,
      freePromoName: normalizeProductName(free_promo_name),
      freePromoQtyPerSale: Math.max(Number(free_promo_qty_per_sale) || 1, 0.001),
      freePromoTotalQty: Math.max(Number(free_promo_total_qty) || 0, 0),
      stockQty: Number(stock_qty) || 0,
      minStockAlert: Number(min_stock_alert) || 10
    };

    const requiredErrors = [];
    if (code_mode === 'MANUAL' && !String(product_code || '').trim()) requiredErrors.push('Product code');
    if (!String(barcode || '').trim()) requiredErrors.push('Barcode');
    if (!values.productName) requiredErrors.push('Product name');
    if (!String(values.hsnCode || '').trim()) requiredErrors.push('HSN code');
    if (!String(gst_percent ?? '').trim()) requiredErrors.push('GST percent');
    if (!String(unit_type ?? '').trim()) requiredErrors.push('Unit');
    if (!String(purchase_unit_type ?? '').trim()) requiredErrors.push('Purchase unit');
    if (!String(purchase_unit_size ?? '').trim()) requiredErrors.push('Stock per purchase unit');
    if (!String(mrp ?? '').trim()) requiredErrors.push('MRP');
    if (!String(purchase_price ?? '').trim()) requiredErrors.push('Purchase price');
    if (!String(sale_price ?? '').trim()) requiredErrors.push('Retail sale price');
    if (!String(stock_qty ?? '').trim()) requiredErrors.push('Current stock');
    if (!String(min_stock_alert ?? '').trim()) requiredErrors.push('Low stock alert');
    if (values.freePromoEnabled && !values.freePromoName) requiredErrors.push('Free promo item name');

    if (requiredErrors.length) {
      return res.status(400).json({ error: `Fill all product columns before saving. Missing: ${requiredErrors.join(', ')}.` });
    }

    if (!Number.isFinite(values.gstPercent) || ![0, 3, 5, 12, 18, 28, 40].includes(values.gstPercent)) {
      return res.status(400).json({ error: 'Select a valid GST percent.' });
    }

    if (values.salePrice > values.mrp && values.mrp > 0) {
      return res.status(400).json({ error: 'Sale price cannot be greater than MRP.' });
    }

    if (values.wholesalePrice > values.mrp && values.mrp > 0) {
      return res.status(400).json({ error: 'Wholesale price cannot be greater than MRP.' });
    }

    if (values.purchasePrice < 0) {
      return res.status(400).json({ error: 'Purchase price cannot be negative.' });
    }

    const finalBarcode = String(barcode || '').trim().toUpperCase();
    let finalProductCode = String(product_code || '').trim().toUpperCase();
    if (!finalProductCode && code_mode !== 'MANUAL') {
      finalProductCode = `BDZ${Date.now().toString().slice(-8)}`;
    }

    await db.query(
      `INSERT INTO products
       (product_code, barcode, product_name, alias_names, hsn_code, gst_percent, unit_type, purchase_unit_type, purchase_unit_size, mrp, purchase_price, sale_price, wholesale_price,
        discount_type, discount_value, bulk_discount_value, is_free_item, free_promo_enabled, free_promo_name, free_promo_qty_per_sale,
        free_promo_total_qty, free_promo_remaining_qty, stock_qty, min_stock_alert)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         product_code = VALUES(product_code),
         product_name = VALUES(product_name),
         alias_names = VALUES(alias_names),
         hsn_code = VALUES(hsn_code),
         gst_percent = VALUES(gst_percent),
         unit_type = VALUES(unit_type),
         purchase_unit_type = VALUES(purchase_unit_type),
         purchase_unit_size = VALUES(purchase_unit_size),
         mrp = VALUES(mrp),
         purchase_price = VALUES(purchase_price),
         sale_price = VALUES(sale_price),
         wholesale_price = VALUES(wholesale_price),
         discount_type = VALUES(discount_type),
         discount_value = VALUES(discount_value),
         bulk_discount_value = VALUES(bulk_discount_value),
         is_free_item = VALUES(is_free_item),
         free_promo_enabled = VALUES(free_promo_enabled),
         free_promo_name = VALUES(free_promo_name),
         free_promo_qty_per_sale = VALUES(free_promo_qty_per_sale),
         free_promo_total_qty = VALUES(free_promo_total_qty),
         free_promo_remaining_qty = VALUES(free_promo_remaining_qty),
         stock_qty = VALUES(stock_qty),
         min_stock_alert = VALUES(min_stock_alert),
         updated_at = CURRENT_TIMESTAMP`,
      [
        finalProductCode,
        finalBarcode,
        values.productName,
        values.aliasNames,
        values.hsnCode,
        values.gstPercent,
        values.unitType,
        values.purchaseUnitType,
        values.purchaseUnitSize,
        values.mrp,
        values.purchasePrice,
        values.salePrice,
        values.wholesalePrice,
        values.discountType,
        values.discountValue,
        values.bulkDiscountValue,
        values.isFreeItem,
        values.freePromoEnabled,
        values.freePromoEnabled ? values.freePromoName : '',
        values.freePromoQtyPerSale,
        values.freePromoEnabled ? values.freePromoTotalQty : 0,
        values.freePromoEnabled ? values.freePromoTotalQty : 0,
        values.stockQty,
        values.minStockAlert
      ]
    );

    const taxSynced = await syncProductTaxByName(db, {
      productName: values.productName,
      aliasNames: values.aliasNames,
      hsnCode: values.hsnCode,
      gstPercent: values.gstPercent
    });

    await writeAuditLog({
      user: req.user,
      action: 'PRODUCT_SAVED',
      entityType: 'PRODUCT',
      entityId: finalBarcode,
      details: {
        barcode: finalBarcode,
        product_name: values.productName,
        alias_names: values.aliasNames,
        hsn_code: values.hsnCode,
        gst_percent: values.gstPercent,
        tax_synced_products: taxSynced,
        purchase_price: values.purchasePrice,
        sale_price: values.salePrice,
        stock_qty: values.stockQty
      }
    });

    res.json({ success: true, taxSynced });
  } catch (err) {
    console.error('Product save failed:', err.message);
    res.status(500).json({ error: 'Unable to save product to database.' });
  }
});

router.post('/bulk-update', authenticate, authorize('SERVER', 'ADMIN'), async (req, res) => {
  const rows = Array.isArray(req.body?.rows) ? req.body.rows : [];
  if (!rows.length) {
    return res.status(400).json({ error: 'At least one product row is required.' });
  }

  const normalizedRows = rows.map((row) => ({
    barcode: String(row.barcode || '').trim(),
    product_name: normalizeProductName(row.product_name),
    hsn_code: String(row.hsn_code || '').trim(),
    gst_percent: Number(row.gst_percent || 0),
    unit_type: normalizeUnitType(row.unit_type)
  }));

  const invalidRow = normalizedRows.find((row) => (
    !row.barcode ||
    !row.product_name ||
    ![0, 3, 5, 12, 18, 28, 40].includes(row.gst_percent)
  ));

  if (invalidRow) {
    return res.status(400).json({ error: 'Every row needs product name and GST must be 0, 3, 5, 12, 18, 28, or 40.' });
  }

  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();

    let taxSynced = 0;
    for (const row of normalizedRows) {
      await connection.query(
        `UPDATE products
         SET product_name = ?, hsn_code = ?, gst_percent = ?, unit_type = ?
         WHERE barcode = ?`,
        [row.product_name, row.hsn_code, row.gst_percent, row.unit_type, row.barcode]
      );
      taxSynced += await syncProductTaxByName(connection, {
        productName: row.product_name,
        aliasNames: '',
        hsnCode: row.hsn_code,
        gstPercent: row.gst_percent
      });
    }

    await writeAuditLog({
      user: req.user,
      action: 'PRODUCT_BULK_UPDATED',
      entityType: 'PRODUCT',
      entityId: `${normalizedRows.length} products`,
      details: {
        count: normalizedRows.length,
        tax_synced_products: taxSynced,
        fields: ['product_name', 'hsn_code', 'gst_percent', 'unit_type']
      },
      connection
    });

    await connection.commit();
    res.json({ success: true, updated: normalizedRows.length, taxSynced });
  } catch (err) {
    await connection.rollback();
    console.error('Product bulk update failed:', err.message);
    res.status(500).json({ error: 'Unable to bulk update products.' });
  } finally {
    connection.release();
  }
});

module.exports = router;
