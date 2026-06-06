const express = require('express');
const router = express.Router();
const db = require('../config/db');
const { authenticate, authorize } = require('../middleware/auth');
const { csvEscape, csvLine } = require('../utils/formatters');
const { writeAuditLog } = require('../services/auditService');
const crypto = require('crypto');

const PRODUCT_DROPBOX_DAYS = 1470;

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
    stock_qty: Number(row.stock_qty || 0),
    min_stock_alert: Number(row.min_stock_alert || 10),
    created_at: row.created_at,
    updated_at: row.updated_at
  };
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

const PRODUCT_CSV_HEADERS = [
  'Sno',
  'Product Code',
  'Description',
  'Alias Names',
  'HSN',
  'MRP',
  'Sale GST %',
  'Unit',
  'Purchase Unit',
  'Stock Per Purchase Unit',
  'Purchase Price',
  'Discount',
  'Sale Net Price',
  'Wholesale Price',
  'Opening Stock',
  'Low Stock Alert'
];

const PRODUCT_EXPORT_HEADERS = [
  'product_code',
  'barcode',
  'product_name',
  'alias_names',
  'hsn_code',
  'gst_percent',
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

const PRODUCT_IMPORT_ALIASES = {
  sno: ['sno', 's no', 'sl no', 'serial', 'serial no'],
  product_code: ['product code', 'product_code', 'item code', 'code', 'plu code'],
  barcode: ['barcode', 'bar code', 'ean', 'ean code'],
  product_name: ['description', 'product name', 'product', 'item name', 'item', 'name'],
  alias_names: ['alias names', 'aliases', 'alias', 'invoice names', 'invoice name', 'supplier names', 'supplier product names'],
  hsn_code: ['hsn', 'hsn code', 'hsn/sac', 'hsn sac'],
  gst_percent: ['sale gst %', 'sale gst', 'gst %', 'gst', 'tax %', 'tax'],
  unit_type: ['unit', 'units', 'unit type', 'uom'],
  purchase_unit_type: ['purchase unit', 'purchase_unit_type', 'purchase pack', 'purchase pack unit', 'pack type'],
  purchase_unit_size: ['stock per purchase unit', 'purchase_unit_size', 'units per pack', 'qty per pack', 'pcs per carton', 'kg per bag', 'conversion'],
  mrp: ['mrp', 'm r p'],
  purchase_price: ['purchase price', 'purchase rate', 'cost price', 'cost'],
  discount_value: ['discount', 'disc', 'disc %', 'discount %'],
  sale_price: ['sale net price', 'sale price', 'selling price', 'retail price', 'net price'],
  wholesale_price: ['wholesale price', 'wholesale rate'],
  stock_qty: ['opening stock', 'stock', 'stock qty', 'current stock'],
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
  const productName = normalizeProductName(rawRow.product_name);
  const aliasNames = normalizeAliasNames(rawRow.alias_names);
  const gstPercent = Number(rawRow.gst_percent || 0);
  const mrp = Number(rawRow.mrp || 0);
  const purchasePrice = Number(rawRow.purchase_price || 0);
  const purchaseUnitSize = Number(rawRow.purchase_unit_size || 1) || 1;
  const salePrice = Number(rawRow.sale_price || rawRow.mrp || 0);
  const wholesalePrice = Number(rawRow.wholesale_price || rawRow.sale_price || rawRow.mrp || 0);
  const discountValue = Number(rawRow.discount_value || 0) || 0;

  const errors = [];
  if (!barcode) errors.push('Product Code or barcode is required');
  if (!productName) errors.push('product_name is required');
  if (!Number.isFinite(gstPercent) || ![0, 3, 5, 12, 18, 28, 40].includes(gstPercent)) errors.push('gst_percent must be 0, 3, 5, 12, 18, 28, or 40');
  if (!Number.isFinite(mrp) || mrp < 0) errors.push('mrp must be a valid number');
  if (!Number.isFinite(purchaseUnitSize) || purchaseUnitSize <= 0) errors.push('purchase_unit_size must be greater than zero');
  if (!Number.isFinite(purchasePrice) || purchasePrice < 0) errors.push('purchase_price must be a valid number');
  if (!Number.isFinite(salePrice) || salePrice < 0) errors.push('sale_price must be a valid number');
  if (mrp > 0 && salePrice > mrp) errors.push('sale_price cannot be greater than mrp');

  return {
    rowNumber,
    errors,
    product: {
      product_code: productCode || null,
      barcode,
      product_name: productName,
      alias_names: aliasNames,
      hsn_code: String(rawRow.hsn_code || '').trim(),
      gst_percent: gstPercent,
      unit_type: normalizeUnitType(rawRow.unit_type),
      purchase_unit_type: normalizePurchaseUnitType(rawRow.purchase_unit_type),
      purchase_unit_size: purchaseUnitSize > 0 ? purchaseUnitSize : 1,
      mrp,
      purchase_price: purchasePrice,
      sale_price: salePrice,
      wholesale_price: Number.isFinite(wholesalePrice) ? wholesalePrice : salePrice,
      discount_type: String(rawRow.discount_type || (discountValue ? 'VALUE' : 'PERCENT')).trim().toUpperCase() === 'VALUE' ? 'VALUE' : 'PERCENT',
      discount_value: discountValue,
      bulk_discount_value: Number(rawRow.bulk_discount_value || 0) || 0,
      is_free_item: ['1', 'TRUE', 'YES', 'Y'].includes(String(rawRow.is_free_item || '').trim().toUpperCase()) ? 1 : 0,
      stock_qty: Number(rawRow.stock_qty || 0) || 0,
      min_stock_alert: Number(rawRow.min_stock_alert || 10) || 10
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

router.get('/export/template', authenticate, authorize('SERVER', 'ADMIN'), (_req, res) => {
  const sampleRows = [
    ['1', '89100100', 'KCP SUGAR', 'KCP SUGAR 1KG, SUGAR KCP', '123456', '80.00', '5', 'Kg', 'Bag', '50', '60.00', '10.00', '70.00', '68.00', '100', '10'],
    ['2', '89102256', 'NAYASA BUCKET', 'NAYASA PLASTCK BUCKET BIG', '2515', '500.00', '18', 'Nos', 'Carton', '12', '400.00', '100.00', '300.00', '285.00', '25', '5'],
    ['3', '8100123', 'ONION', 'ONIONS, PYAJ', '44155', '', '0', 'Kg', 'Bag', '40', '25.00', '', '30.00', '28.00', '50', '10'],
    ['4', '892456', 'THUMS UP 2.LT BOTTLE', 'THUMS UP 2L, THUMSUP 2LT', '51456', '100.00', '40', 'Nos', 'Case', '6', '80.00', '10.00', '90.00', '87.00', '20', '5']
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

router.post('/import', authenticate, authorize('SERVER', 'ADMIN'), async (req, res) => {
  const csvText = String(req.body?.csv || '');

  if (!csvText.trim()) {
    return res.status(400).json({ error: 'CSV file content is required.' });
  }

  const parsedRows = parseCsv(csvText);
  if (parsedRows.length < 2) {
    return res.status(400).json({ error: 'CSV must include header and at least one product row.' });
  }

  const headers = mapImportHeaders(parsedRows[0]);
  const hasProductCode = headers.includes('product_code') || headers.includes('barcode');
  const missingHeaders = [
    ...(!hasProductCode ? ['Product Code'] : []),
    ...(['product_name', 'gst_percent', 'mrp', 'sale_price'].filter((header) => !headers.includes(header)))
  ];
  if (missingHeaders.length) {
    return res.status(400).json({ error: `Missing required columns: ${missingHeaders.join(', ')}` });
  }

  const seenBarcodes = new Set();
  const seenProductCodes = new Map();
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

    if (seenBarcodes.has(normalized.product.barcode)) {
      normalized.errors.push('duplicate barcode in CSV');
    }
    seenBarcodes.add(normalized.product.barcode);

    if (normalized.product.product_code) {
      const existingBarcodeForCode = seenProductCodes.get(normalized.product.product_code);
      if (existingBarcodeForCode && existingBarcodeForCode !== normalized.product.barcode) {
        normalized.errors.push('duplicate product_code in CSV');
      }
      seenProductCodes.set(normalized.product.product_code, normalized.product.barcode);
    }

    if (normalized.errors.length) {
      errors.push({ row: normalized.rowNumber, barcode: normalized.product.barcode, errors: normalized.errors });
    } else {
      products.push(normalized.product);
    }
  });

  if (errors.length) {
    return res.status(400).json({
      error: 'CSV validation failed.',
      summary: {
        totalRows: parsedRows.length - 1,
        validRows: products.length,
        errorRows: errors.length
      },
      errors: errors.slice(0, 100)
    });
  }

  const productCodes = products.map((product) => product.product_code).filter(Boolean);
  if (productCodes.length) {
    const placeholders = productCodes.map(() => '?').join(',');
    const [conflictingRows] = await db.query(
      `SELECT product_code, barcode FROM products WHERE product_code IN (${placeholders})`,
      productCodes
    );

    const incomingByCode = new Map(products.map((product) => [product.product_code, product.barcode]));
    const conflicts = conflictingRows
      .filter((row) => incomingByCode.get(row.product_code) !== row.barcode)
      .map((row) => ({
        row: '-',
        barcode: row.barcode,
        errors: [`product_code ${row.product_code} already belongs to barcode ${row.barcode}`]
      }));

    if (conflicts.length) {
      return res.status(400).json({
        error: 'CSV validation failed.',
        summary: {
          totalRows: parsedRows.length - 1,
          validRows: products.length - conflicts.length,
          errorRows: conflicts.length
        },
        errors: conflicts.slice(0, 100)
      });
    }
  }

  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();

    let inserted = 0;
    let updated = 0;
    let taxSynced = 0;

    for (const product of products) {
      const [existingRows] = await connection.query(
        `SELECT id FROM products WHERE barcode = ? LIMIT 1`,
        [product.barcode]
      );
      const existed = existingRows.length > 0;

      await connection.query(
        `INSERT INTO products
         (product_code, barcode, product_name, alias_names, hsn_code, gst_percent, unit_type, purchase_unit_type, purchase_unit_size, mrp, purchase_price, sale_price, wholesale_price,
          discount_type, discount_value, bulk_discount_value, is_free_item, stock_qty, min_stock_alert)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
           stock_qty = VALUES(stock_qty),
           min_stock_alert = VALUES(min_stock_alert)`,
        [
          product.product_code,
          product.barcode,
          product.product_name,
          product.alias_names,
          product.hsn_code,
          product.gst_percent,
          product.unit_type,
          product.purchase_unit_type,
          product.purchase_unit_size,
          product.mrp,
          product.purchase_price,
          product.sale_price,
          product.wholesale_price,
          product.discount_type,
          product.discount_value,
          product.bulk_discount_value,
          product.is_free_item,
          product.stock_qty,
          product.min_stock_alert
        ]
      );

      if (existed) updated += 1;
      else inserted += 1;

      taxSynced += await syncProductTaxByName(connection, {
        productName: product.product_name,
        aliasNames: product.alias_names,
        hsnCode: product.hsn_code,
        gstPercent: product.gst_percent
      });
    }

    await connection.commit();
    res.json({
      success: true,
      summary: {
        totalRows: products.length,
        inserted,
        updated,
        taxSynced,
        skipped: 0
      }
    });
  } catch (err) {
    await connection.rollback();
    console.error('Product import failed:', err.message);
    res.status(500).json({ error: 'Unable to import products.' });
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
      `SELECT id, barcode, product_name, hsn_code, gst_percent, unit_type
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
    if (!String(wholesale_price ?? '').trim()) requiredErrors.push('Wholesale price');
    if (!String(discount_value ?? '').trim()) requiredErrors.push('Discount');
    if (!String(bulk_discount_value ?? '').trim()) requiredErrors.push('Wholesale discount');
    if (!String(stock_qty ?? '').trim()) requiredErrors.push('Current stock');
    if (!String(min_stock_alert ?? '').trim()) requiredErrors.push('Low stock alert');

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
        discount_type, discount_value, bulk_discount_value, is_free_item, stock_qty, min_stock_alert)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
