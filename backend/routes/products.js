const express = require('express');
const router = express.Router();
const db = require('../config/db');
const { authenticate, authorize } = require('../middleware/auth');
const { csvEscape, csvLine } = require('../utils/formatters');
const { writeAuditLog } = require('../services/auditService');

function toProduct(row) {
  return {
    id: row.id,
    product_code: row.product_code || '',
    barcode: row.barcode,
    product_name: row.product_name,
    hsn_code: row.hsn_code || '',
    gst_percent: Number(row.gst_percent || 0),
    mrp: Number(row.mrp || 0),
    sale_price: Number(row.sale_price || 0),
    wholesale_price: Number(row.wholesale_price || row.sale_price || 0),
    discount_type: row.discount_type || 'PERCENT',
    discount_value: Number(row.discount_value || 0),
    bulk_discount_value: Number(row.bulk_discount_value || 0),
    is_free_item: Boolean(row.is_free_item),
    stock_qty: Number(row.stock_qty || 0),
    min_stock_alert: Number(row.min_stock_alert || 10)
  };
}

const PRODUCT_CSV_HEADERS = [
  'product_code',
  'barcode',
  'product_name',
  'hsn_code',
  'gst_percent',
  'mrp',
  'sale_price',
  'wholesale_price',
  'discount_type',
  'discount_value',
  'bulk_discount_value',
  'is_free_item',
  'stock_qty',
  'min_stock_alert'
];

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
  const barcode = String(rawRow.barcode || '').trim().toUpperCase();
  const productName = String(rawRow.product_name || '').trim();
  const gstPercent = Number(rawRow.gst_percent || 0);
  const mrp = Number(rawRow.mrp || 0);
  const salePrice = Number(rawRow.sale_price || 0);
  const wholesalePrice = Number(rawRow.wholesale_price || rawRow.sale_price || 0);

  const errors = [];
  if (!barcode) errors.push('barcode is required');
  if (!productName) errors.push('product_name is required');
  if (!Number.isFinite(gstPercent) || ![0, 3, 5, 12, 18, 40].includes(gstPercent)) errors.push('gst_percent must be 0, 3, 5, 12, 18, or 40');
  if (!Number.isFinite(mrp) || mrp < 0) errors.push('mrp must be a valid number');
  if (!Number.isFinite(salePrice) || salePrice < 0) errors.push('sale_price must be a valid number');
  if (mrp > 0 && salePrice > mrp) errors.push('sale_price cannot be greater than mrp');

  return {
    rowNumber,
    errors,
    product: {
      product_code: String(rawRow.product_code || '').trim().toUpperCase() || null,
      barcode,
      product_name: productName,
      hsn_code: String(rawRow.hsn_code || '').trim(),
      gst_percent: gstPercent,
      mrp,
      sale_price: salePrice,
      wholesale_price: Number.isFinite(wholesalePrice) ? wholesalePrice : salePrice,
      discount_type: String(rawRow.discount_type || 'PERCENT').trim().toUpperCase() === 'VALUE' ? 'VALUE' : 'PERCENT',
      discount_value: Number(rawRow.discount_value || 0) || 0,
      bulk_discount_value: Number(rawRow.bulk_discount_value || 0) || 0,
      is_free_item: ['1', 'TRUE', 'YES', 'Y'].includes(String(rawRow.is_free_item || '').trim().toUpperCase()) ? 1 : 0,
      stock_qty: Number(rawRow.stock_qty || 0) || 0,
      min_stock_alert: Number(rawRow.min_stock_alert || 10) || 10
    }
  };
}

router.get('/', authenticate, authorize('SERVER', 'ADMIN', 'COUNTER'), async (req, res) => {
  try {
    const page = Math.max(Number.parseInt(req.query.page, 10) || 1, 1);
    const limit = Math.min(Math.max(Number.parseInt(req.query.limit, 10) || 50, 10), 100);
    const offset = (page - 1) * limit;
    const search = String(req.query.search || '').trim();
    const gst = String(req.query.gst || '').trim();
    const where = [];
    const values = [];

    if (search) {
      where.push('(product_name LIKE ? OR barcode LIKE ? OR product_code LIKE ?)');
      values.push(`%${search}%`, `%${search}%`, `%${search}%`);
    }

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
         COALESCE(SUM(stock_qty * sale_price), 0) AS inventory_value
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
  const sample = {
    product_code: 'BDZ001',
    barcode: '8901719110086',
    product_name: 'Parle G Biscuits 100g',
    hsn_code: '1905',
    gst_percent: '5',
    mrp: '10',
    sale_price: '8',
    wholesale_price: '7.5',
    discount_type: 'PERCENT',
    discount_value: '0',
    bulk_discount_value: '0',
    is_free_item: '0',
    stock_qty: '100',
    min_stock_alert: '10'
  };

  const csv = [
    csvLine(PRODUCT_CSV_HEADERS),
    csvLine(PRODUCT_CSV_HEADERS.map((header) => sample[header]))
  ].join('\n');

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="badizo_product_import_template.csv"');
  res.send(csv);
});

router.get('/export', authenticate, authorize('SERVER', 'ADMIN'), async (_req, res) => {
  try {
    const [rows] = await db.query(`SELECT * FROM products ORDER BY product_name ASC`);
    const csv = [
      csvLine(PRODUCT_CSV_HEADERS),
      ...rows.map((row) => csvLine(PRODUCT_CSV_HEADERS.map((header) => {
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

  const headers = parsedRows[0].map((header) => header.trim());
  const missingHeaders = ['barcode', 'product_name', 'gst_percent', 'mrp', 'sale_price'].filter((header) => !headers.includes(header));
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

    for (const product of products) {
      const [existingRows] = await connection.query(
        `SELECT id FROM products WHERE barcode = ? LIMIT 1`,
        [product.barcode]
      );
      const existed = existingRows.length > 0;

      await connection.query(
        `INSERT INTO products
         (product_code, barcode, product_name, hsn_code, gst_percent, mrp, sale_price, wholesale_price,
          discount_type, discount_value, bulk_discount_value, is_free_item, stock_qty, min_stock_alert)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
           product_code = VALUES(product_code),
           product_name = VALUES(product_name),
           hsn_code = VALUES(hsn_code),
           gst_percent = VALUES(gst_percent),
           mrp = VALUES(mrp),
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
          product.hsn_code,
          product.gst_percent,
          product.mrp,
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
    }

    await connection.commit();
    res.json({
      success: true,
      summary: {
        totalRows: products.length,
        inserted,
        updated,
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

    if (q.length >= 3) {
      const [rows] = await db.query(
        `SELECT * FROM products
         WHERE product_name LIKE ? OR barcode LIKE ? OR product_code LIKE ?
         ORDER BY product_name ASC
         LIMIT 5`,
        [`%${q}%`, `%${q}%`, `%${q}%`]
      );
      return res.json((rows || []).map(toProduct));
    }

    const [rows] = await db.query(
      `SELECT * FROM products WHERE barcode = ? LIMIT 1`,
      [q]
    );

    if (!rows || rows.length === 0) {
      return res.status(404).json({ error: 'Product not found.' });
    }

    res.json([toProduct(rows[0])]);
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
    hsn_code,
    gst_percent,
    mrp,
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
      gstPercent: Number(gst_percent) || 0,
      mrp: Number(mrp) || 0,
      salePrice: Number(sale_price) || 0,
      wholesalePrice: Number(wholesale_price || sale_price) || 0,
      discountType: discount_type === 'VALUE' ? 'VALUE' : 'PERCENT',
      discountValue: Number(discount_value) || 0,
      bulkDiscountValue: Number(bulk_discount_value) || 0,
      isFreeItem: is_free_item ? 1 : 0,
      stockQty: Number(stock_qty) || 0,
      minStockAlert: Number(min_stock_alert) || 10
    };

    if (values.salePrice > values.mrp && values.mrp > 0) {
      return res.status(400).json({ error: 'Sale price cannot be greater than MRP.' });
    }

    let finalProductCode = product_code && product_code.trim();
    if (!finalProductCode && code_mode !== 'MANUAL') {
      finalProductCode = `BDZ${Date.now().toString().slice(-8)}`;
    }

    await db.query(
      `INSERT INTO products
       (product_code, barcode, product_name, hsn_code, gst_percent, mrp, sale_price, wholesale_price,
        discount_type, discount_value, bulk_discount_value, is_free_item, stock_qty, min_stock_alert)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         product_code = VALUES(product_code),
         product_name = VALUES(product_name),
         hsn_code = VALUES(hsn_code),
         gst_percent = VALUES(gst_percent),
         mrp = VALUES(mrp),
         sale_price = VALUES(sale_price),
         wholesale_price = VALUES(wholesale_price),
         discount_type = VALUES(discount_type),
         discount_value = VALUES(discount_value),
         bulk_discount_value = VALUES(bulk_discount_value),
         is_free_item = VALUES(is_free_item),
         stock_qty = VALUES(stock_qty),
         min_stock_alert = VALUES(min_stock_alert)`,
      [
        finalProductCode,
        barcode.trim(),
        product_name.trim(),
        values.hsnCode,
        values.gstPercent,
        values.mrp,
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

    await writeAuditLog({
      user: req.user,
      action: 'PRODUCT_SAVED',
      entityType: 'PRODUCT',
      entityId: barcode.trim(),
      details: {
        barcode: barcode.trim(),
        product_name: product_name.trim(),
        sale_price: values.salePrice,
        stock_qty: values.stockQty
      }
    });

    res.json({ success: true });
  } catch (err) {
    console.error('Product save failed:', err.message);
    res.status(500).json({ error: 'Unable to save product to database.' });
  }
});

module.exports = router;
