const express = require('express');
const router = express.Router();
const db = require('../config/db');
const { authenticate, authorize } = require('../middleware/auth');
const { writeAuditLog } = require('../services/auditService');
const { parseMoney } = require('../utils/formatters');

function inwardNo() {
  const now = new Date();
  const stamp = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0'),
    String(now.getHours()).padStart(2, '0'),
    String(now.getMinutes()).padStart(2, '0'),
    String(now.getSeconds()).padStart(2, '0'),
    String(now.getMilliseconds()).padStart(3, '0')
  ].join('');
  return `INW-${stamp}`;
}

function normalizeDiscountType(value) {
  return String(value || '').toUpperCase() === 'VALUE' ? 'VALUE' : 'PERCENT';
}

function calculateLineReduction(baseAmount, value, type) {
  const amount = parseMoney(value);
  if (amount <= 0 || baseAmount <= 0) return 0;
  const reduction = normalizeDiscountType(type) === 'VALUE' ? amount : baseAmount * (amount / 100);
  return Math.min(reduction, baseAmount);
}

function calculateInwardLine(line, taxType) {
  if (line.last_amount_input === 'TOTAL' && Number.isFinite(line.total_amount)) {
    const lineTotal = Number(line.total_amount.toFixed(2));
    const gstFactor = 1 + (line.gst_percent / 100);
    const taxable = Number((gstFactor > 0 ? lineTotal / gstFactor : lineTotal).toFixed(2));
    const gstAmount = Number((lineTotal - taxable).toFixed(2));
    const cgstAmount = taxType === 'LOCAL' ? Number((gstAmount / 2).toFixed(2)) : 0;
    const sgstAmount = taxType === 'LOCAL' ? Number((gstAmount / 2).toFixed(2)) : 0;
    const igstAmount = taxType === 'INTERSTATE' ? gstAmount : 0;
    const discountAmount = line.discount_type === 'VALUE' ? parseMoney(line.discount_value) : 0;
    const schemeAmount = line.scheme_type === 'VALUE' ? parseMoney(line.scheme_value) : 0;

    return {
      discountAmount,
      schemeAmount,
      taxable,
      gstAmount,
      cgstAmount,
      sgstAmount,
      igstAmount,
      lineTotal
    };
  }

  const gross = line.purchase_price * line.quantity;
  const discountAmount = calculateLineReduction(gross, line.discount_value, line.discount_type);
  const schemeAmount = calculateLineReduction(gross - discountAmount, line.scheme_value, line.scheme_type);
  const taxable = Math.max(gross - discountAmount - schemeAmount, 0);
  const gstAmount = taxable * (line.gst_percent / 100);

  return {
    discountAmount,
    schemeAmount,
    taxable,
    gstAmount,
    cgstAmount: taxType === 'LOCAL' ? gstAmount / 2 : 0,
    sgstAmount: taxType === 'LOCAL' ? gstAmount / 2 : 0,
    igstAmount: taxType === 'INTERSTATE' ? gstAmount : 0,
    lineTotal: taxable + gstAmount
  };
}

function normalizeProductName(value) {
  return String(value || '').trim().replace(/\s+/g, ' ').toUpperCase();
}

function normalizePaymentMode(value) {
  return String(value || '').toUpperCase() === 'CASH' ? 'Cash' : 'Credit';
}

function normalizeExpiryDate(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString().slice(0, 10);
}

function normalizeStockConversionFactor(value) {
  const factor = parseMoney(value);
  return factor > 0 ? factor : 1;
}

function generatedBarcodeForInwardLine(line) {
  const source = `${line.product_name || ''}|${line.hsn_code || ''}`;
  let hash = 0;
  for (let index = 0; index < source.length; index += 1) {
    hash = ((hash << 5) - hash) + source.charCodeAt(index);
    hash |= 0;
  }
  return `INV-${Math.abs(hash).toString(36).toUpperCase().padStart(6, '0')}`;
}

function pendingBarcodeForDraftLine(line) {
  return generatedBarcodeForInwardLine(line).replace(/^INV-/, 'PENDING-');
}

function isInternalBarcode(value) {
  return /^(INV|PENDING)-/i.test(String(value || ''));
}

router.use(authenticate, authorize('SERVER', 'ADMIN'));

router.get('/recent', async (_req, res) => {
  try {
    const [rows] = await db.query(
      `SELECT id, inward_no, supplier_name, supplier_invoice_no, supplier_invoice_date, payment_mode,
              item_count, total_qty, taxable_total, gst_total, total_cgst, total_sgst, total_igst,
              grand_total, tax_type, posting_status, created_by, created_at
       FROM inward_entries
       ORDER BY created_at DESC
       LIMIT 25`
    );
    res.json(rows);
  } catch (err) {
    console.error('Inward recent fetch failed:', err.message);
    res.status(500).json({ error: 'Unable to fetch inward entries.' });
  }
});

router.get('/history', async (req, res) => {
  const { from, to, supplier = '', invoice = '' } = req.query || {};
  const clauses = [];
  const params = [];

  if (from) {
    clauses.push('DATE(created_at) >= ?');
    params.push(from);
  }
  if (to) {
    clauses.push('DATE(created_at) <= ?');
    params.push(to);
  }
  if (String(supplier).trim()) {
    clauses.push('supplier_name LIKE ?');
    params.push(`%${String(supplier).trim()}%`);
  }
  if (String(invoice).trim()) {
    clauses.push('(supplier_invoice_no LIKE ? OR inward_no LIKE ?)');
    params.push(`%${String(invoice).trim()}%`, `%${String(invoice).trim()}%`);
  }

  try {
    const [rows] = await db.query(
      `SELECT id, inward_no, supplier_name, supplier_invoice_no, supplier_invoice_date, payment_mode,
              item_count, total_qty, taxable_total, gst_total, total_cgst, total_sgst, total_igst,
              grand_total, tax_type, posting_status, created_by, created_at
       FROM inward_entries
       ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''}
       ORDER BY id DESC
       LIMIT 200`,
      params
    );
    res.json(rows);
  } catch (err) {
    console.error('Inward history fetch failed:', err.message);
    res.status(500).json({ error: 'Unable to fetch inward history.' });
  }
});

router.get('/suppliers/search', async (req, res) => {
  const q = String(req.query.q || '').trim();

  if (q.length < 3) {
    return res.json([]);
  }

  const like = `%${q}%`;

  try {
    const [rows] = await db.query(
      `SELECT e.supplier_name, e.supplier_address, e.supplier_gstin, e.supplier_phone,
              e.supplier_invoice_no, e.supplier_invoice_date, e.created_at
       FROM inward_entries e
       INNER JOIN (
         SELECT MAX(id) AS id
         FROM inward_entries
         WHERE supplier_name LIKE ? OR supplier_gstin LIKE ? OR supplier_phone LIKE ?
         GROUP BY UPPER(TRIM(supplier_name)), UPPER(TRIM(COALESCE(supplier_gstin, '')))
       ) latest ON latest.id = e.id
       ORDER BY e.id DESC
       LIMIT 12`,
      [like, like, like]
    );

    res.json(rows.map((row) => ({
      name: row.supplier_name || '',
      address: row.supplier_address || '',
      gstin: row.supplier_gstin || '',
      phone: row.supplier_phone || '',
      last_invoice_no: row.supplier_invoice_no || '',
      last_invoice_date: row.supplier_invoice_date || '',
      last_used_at: row.created_at || ''
    })));
  } catch (err) {
    console.error('Supplier lookup failed:', err.message);
    res.status(500).json({ error: 'Unable to search old suppliers.' });
  }
});

router.get('/by-number/:inwardNo/details', async (req, res) => {
  const inwardNo = String(req.params.inwardNo || '').trim();
  if (!inwardNo) {
    return res.status(400).json({ error: 'Valid inward number is required.' });
  }

  try {
    const [entryRows] = await db.query(
      `SELECT id, inward_no, supplier_name, supplier_address, supplier_gstin, supplier_phone,
              supplier_invoice_no, supplier_invoice_date, payment_mode, item_count, total_qty, taxable_total,
              gst_total, total_cgst, total_sgst, total_igst, grand_total, tax_type, posting_status, created_by, created_at
       FROM inward_entries
       WHERE inward_no = ?
       LIMIT 1`,
      [inwardNo]
    );

    if (!entryRows.length) {
      return res.status(404).json({ error: 'Inward bill not found.' });
    }

    const [items] = await db.query(
      `SELECT id, barcode, product_name, hsn_code, gst_percent, purchase_price, discount_percent,
              discount_type, discount_amount, scheme, scheme_type, scheme_value, scheme_amount,
              batch_no, expiry_date, mrp, free_qty, quantity, taxable_amount, gst_amount, cgst_amount, sgst_amount,
              igst_amount, total_amount
       FROM inward_items
       WHERE inward_no = ?
       ORDER BY id ASC`,
      [entryRows[0].inward_no]
    );

    res.json({ entry: entryRows[0], items });
  } catch (err) {
    console.error('Inward detail fetch by number failed:', err.message);
    res.status(500).json({ error: 'Unable to fetch inward bill details.' });
  }
});

router.get('/:id/details', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ error: 'Valid inward S.No is required.' });
  }

  try {
    const [entryRows] = await db.query(
      `SELECT id, inward_no, supplier_name, supplier_address, supplier_gstin, supplier_phone,
              supplier_invoice_no, supplier_invoice_date, payment_mode, item_count, total_qty, taxable_total,
              gst_total, total_cgst, total_sgst, total_igst, grand_total, tax_type, posting_status, created_by, created_at
       FROM inward_entries
       WHERE id = ?
       LIMIT 1`,
      [id]
    );

    if (!entryRows.length) {
      return res.status(404).json({ error: 'Inward bill not found.' });
    }

    const [items] = await db.query(
      `SELECT id, barcode, product_name, hsn_code, gst_percent, purchase_price, discount_percent,
              discount_type, discount_amount, scheme, scheme_type, scheme_value, scheme_amount,
              batch_no, expiry_date, mrp, free_qty, quantity, taxable_amount, gst_amount, cgst_amount, sgst_amount,
              igst_amount, total_amount
       FROM inward_items
       WHERE inward_no = ?
       ORDER BY id ASC`,
      [entryRows[0].inward_no]
    );

    res.json({ entry: entryRows[0], items });
  } catch (err) {
    console.error('Inward detail fetch failed:', err.message);
    res.status(500).json({ error: 'Unable to fetch inward bill details.' });
  }
});

router.post('/', async (req, res) => {
  const { supplier = {}, lines = [] } = req.body || {};
  const taxType = req.body?.tax_type === 'INTERSTATE' ? 'INTERSTATE' : 'LOCAL';
  const paymentMode = normalizePaymentMode(req.body?.payment_mode || supplier.payment_mode);
  const isDraft = req.body?.posting_status === 'DRAFT' || req.body?.is_draft === true;

  if (!supplier.name || !String(supplier.name).trim()) {
    return res.status(400).json({ error: 'Supplier name is required.' });
  }

  const validLines = Array.isArray(lines)
    ? lines
      .map((line) => {
        const normalized = {
          product_name: normalizeProductName(line.product || line.product_name),
          barcode: String(line.barcode || '').trim().toUpperCase(),
          hsn_code: String(line.hsn_code || '').trim(),
          gst_percent: parseMoney(line.gst_percent),
          mrp: parseMoney(line.mrp),
          purchase_price: parseMoney(line.price || line.purchase_price),
          discount_type: normalizeDiscountType(line.discount_type),
          discount_value: parseMoney(line.discount),
          scheme_type: normalizeDiscountType(line.scheme_type),
          scheme_value: parseMoney(line.scheme),
          batch_no: String(line.batch_no || line.batch || '').trim().toUpperCase(),
          expiry_date: normalizeExpiryDate(line.expiry_date || line.expiry),
          free_qty: parseMoney(line.free || line.free_qty),
          quantity: parseMoney(line.qty || line.quantity),
          stock_conversion_factor: normalizeStockConversionFactor(line.stock_conversion_factor || line.purchase_unit_size),
          total_amount: parseMoney(line.total_amount),
          last_amount_input: String(line.last_amount_input || '').toUpperCase(),
          is_adjustment: Boolean(line.is_adjustment) || /^ADJ-/i.test(String(line.barcode || ''))
        };
        if (!normalized.barcode && normalized.product_name && !normalized.is_adjustment && isDraft) {
          normalized.barcode = pendingBarcodeForDraftLine(normalized);
        }
        return normalized;
      })
      .filter((line) => line.product_name || line.barcode || line.quantity)
    : [];

  if (validLines.length === 0) {
    return res.status(400).json({ error: 'At least one inward product line is required.' });
  }

  const invalidLine = validLines.find((line) => (
    !line.product_name
    || !line.barcode
    || (!isDraft && !line.is_adjustment && isInternalBarcode(line.barcode))
    || line.quantity <= 0
    || (!line.is_adjustment && line.purchase_price < 0)
  ));
  if (invalidLine) {
    return res.status(400).json({ error: isDraft ? 'Every draft line needs product and quantity.' : 'Before posting inward, every product line needs mapped real barcode, quantity, and valid price.' });
  }

  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();
    const finalInwardNo = inwardNo();

    let totalQty = 0;
    let taxableTotal = 0;
    let gstTotal = 0;
    let cgstTotal = 0;
    let sgstTotal = 0;
    let igstTotal = 0;
    let grandTotal = 0;

    const [entryResult] = await connection.query(
      `INSERT INTO inward_entries
       (inward_no, supplier_name, supplier_address, supplier_gstin, supplier_phone,
        supplier_invoice_no, supplier_invoice_date, payment_mode, item_count, total_qty, taxable_total,
        gst_total, total_cgst, total_sgst, total_igst, grand_total, tax_type, posting_status, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 0, 0, 0, 0, 0, 0, ?, ?, ?)`,
      [
        finalInwardNo,
        String(supplier.name || '').trim(),
        String(supplier.address || '').trim(),
        String(supplier.gstin || '').trim().toUpperCase(),
        String(supplier.phone || '').trim(),
        String(supplier.invoice_no || '').trim(),
        supplier.invoice_date || null,
        paymentMode,
        taxType,
        isDraft ? 'DRAFT' : 'POSTED',
        req.user.username
      ]
    );

    for (const line of validLines) {
      const calculated = calculateInwardLine(line, taxType);
      const stockQty = (line.is_adjustment || isDraft) ? 0 : (line.quantity + line.free_qty) * line.stock_conversion_factor;
      const basePurchasePrice = line.stock_conversion_factor > 0 ? line.purchase_price / line.stock_conversion_factor : line.purchase_price;

      totalQty += (line.is_adjustment || isDraft) ? 0 : stockQty;
      taxableTotal += calculated.taxable;
      gstTotal += calculated.gstAmount;
      cgstTotal += calculated.cgstAmount;
      sgstTotal += calculated.sgstAmount;
      igstTotal += calculated.igstAmount;
      grandTotal += calculated.lineTotal;

      await connection.query(
        `INSERT INTO inward_items
         (inward_no, barcode, product_name, hsn_code, gst_percent, purchase_price, discount_percent,
          discount_type, discount_amount, scheme, scheme_type, scheme_value, scheme_amount,
          batch_no, expiry_date, mrp, free_qty, quantity, taxable_amount, gst_amount, cgst_amount, sgst_amount, igst_amount, total_amount)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          finalInwardNo,
          line.barcode,
          line.product_name,
          line.hsn_code,
          line.gst_percent,
          line.purchase_price,
          line.discount_type === 'PERCENT' ? line.discount_value : 0,
          line.discount_type,
          calculated.discountAmount,
          String(line.scheme_value || ''),
          line.scheme_type,
          line.scheme_value,
          calculated.schemeAmount,
          line.batch_no,
          line.expiry_date,
          line.mrp,
          line.free_qty,
          line.quantity,
          calculated.taxable,
          calculated.gstAmount,
          calculated.cgstAmount,
          calculated.sgstAmount,
          calculated.igstAmount,
          calculated.lineTotal
        ]
      );

      if (!line.is_adjustment && !isDraft) {
        await connection.query(
          `INSERT INTO product_batches
           (barcode, batch_no, expiry_date, inward_no, purchase_price, mrp, quantity_received, quantity_available)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON DUPLICATE KEY UPDATE
             inward_no = VALUES(inward_no),
             purchase_price = VALUES(purchase_price),
             mrp = VALUES(mrp),
             quantity_received = quantity_received + VALUES(quantity_received),
             quantity_available = quantity_available + VALUES(quantity_available)`,
          [
            line.barcode,
            line.batch_no || '',
            line.expiry_date,
            finalInwardNo,
            basePurchasePrice,
            line.mrp,
            stockQty,
            stockQty
          ]
        );

        const [existingRows] = await connection.query(
          `SELECT barcode FROM products WHERE barcode = ? LIMIT 1`,
          [line.barcode]
        );

        if (existingRows.length) {
          await connection.query(
            `UPDATE products
             SET stock_qty = stock_qty + ?,
                 product_name = COALESCE(NULLIF(?, ''), product_name),
                 hsn_code = COALESCE(NULLIF(?, ''), hsn_code),
                 gst_percent = ?,
                 purchase_price = ?
             WHERE barcode = ?`,
            [stockQty, line.product_name, line.hsn_code, line.gst_percent, basePurchasePrice, line.barcode]
          );
        } else {
          await connection.query(
            `INSERT INTO products
             (product_code, barcode, product_name, hsn_code, gst_percent, mrp, purchase_price, sale_price, wholesale_price, stock_qty)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              line.barcode,
              line.barcode,
              line.product_name,
              line.hsn_code,
              line.gst_percent,
              line.mrp || basePurchasePrice,
              basePurchasePrice,
              basePurchasePrice,
              basePurchasePrice,
              stockQty
            ]
          );
        }
      }
    }

    await connection.query(
      `UPDATE inward_entries
       SET item_count = ?, total_qty = ?, taxable_total = ?, gst_total = ?,
           total_cgst = ?, total_sgst = ?, total_igst = ?, grand_total = ?
       WHERE inward_no = ?`,
      [validLines.length, totalQty, taxableTotal, gstTotal, cgstTotal, sgstTotal, igstTotal, grandTotal, finalInwardNo]
    );

    await writeAuditLog({
      user: req.user,
      action: 'INWARD_CREATED',
      entityType: 'INWARD',
      entityId: finalInwardNo,
      details: {
        supplier: supplier.name,
        paymentMode,
        itemCount: validLines.length,
        totalQty,
        grandTotal,
        taxType,
        postingStatus: isDraft ? 'DRAFT' : 'POSTED'
      },
      connection
    });

    if (!isDraft && Number(req.body?.source_draft_id || 0) > 0) {
      await connection.query(
        `DELETE FROM inward_entries WHERE id = ? AND posting_status = 'DRAFT'`,
        [Number(req.body.source_draft_id)]
      );
    }

    await connection.commit();
    res.json({
      success: true,
      id: entryResult.insertId,
      serial_no: entryResult.insertId,
      inward_no: finalInwardNo,
      item_count: validLines.length,
      total_qty: totalQty,
      payment_mode: paymentMode,
      posting_status: isDraft ? 'DRAFT' : 'POSTED',
      grand_total: grandTotal
    });
  } catch (err) {
    await connection.rollback();
    console.error('Inward save failed:', err.message);
    res.status(500).json({ error: err.message || 'Unable to save inward entry.' });
  } finally {
    connection.release();
  }
});

module.exports = router;
