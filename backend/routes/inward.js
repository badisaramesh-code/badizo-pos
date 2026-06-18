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

function purchaseOrderNo() {
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
  return `PO-${stamp}`;
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
  const gross = line.purchase_price * line.quantity;
  const discountAmount = calculateLineReduction(gross, line.discount_value, line.discount_type);
  const schemeAmount = calculateLineReduction(gross - discountAmount, line.scheme_value, line.scheme_type);
  const taxable = Math.max(gross - discountAmount - schemeAmount, 0);
  const gstAmount = taxable * (line.gst_percent / 100);
  const rateBasedTotal = taxable + gstAmount;
  const hasFreeQty = parseMoney(line.free_qty) > 0;

  if (
    line.last_amount_input === 'TOTAL'
    && Number.isFinite(line.total_amount)
    && !(hasFreeQty && line.total_amount > rateBasedTotal + 0.01)
  ) {
    const lineTotal = Number(line.total_amount.toFixed(2));
    const gstFactor = 1 + (line.gst_percent / 100);
    const overrideTaxable = Number((gstFactor > 0 ? lineTotal / gstFactor : lineTotal).toFixed(2));
    const overrideGstAmount = Number((lineTotal - overrideTaxable).toFixed(2));
    const cgstAmount = taxType === 'LOCAL' ? Number((overrideGstAmount / 2).toFixed(2)) : 0;
    const sgstAmount = taxType === 'LOCAL' ? Number((overrideGstAmount / 2).toFixed(2)) : 0;
    const igstAmount = taxType === 'INTERSTATE' ? overrideGstAmount : 0;
    const overrideDiscountAmount = line.discount_type === 'VALUE' ? parseMoney(line.discount_value) : 0;
    const overrideSchemeAmount = line.scheme_type === 'VALUE' ? parseMoney(line.scheme_value) : 0;

    return {
      discountAmount: overrideDiscountAmount,
      schemeAmount: overrideSchemeAmount,
      taxable: overrideTaxable,
      gstAmount: overrideGstAmount,
      cgstAmount,
      sgstAmount,
      igstAmount,
      lineTotal
    };
  }

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

function normalizeSupplierPaymentMode(value) {
  const raw = String(value || '').trim().toUpperCase();
  if (raw === 'CASH') return 'Cash';
  if (raw === 'UPI') return 'UPI';
  if (raw === 'CHEQUE' || raw === 'CHECK') return 'Cheque';
  if (raw === 'OTHER') return 'Other';
  return 'Bank Transfer';
}

function paymentStatusFor(dueAmount, dueDate) {
  if (dueAmount <= 0.01) return 'PAID';
  if (dueDate) {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const due = new Date(dueDate);
    due.setHours(0, 0, 0, 0);
    if (!Number.isNaN(due.getTime()) && due < today) return 'OVERDUE';
  }
  return 'DUE';
}

function normalizePaymentTerms(value) {
  const raw = String(value || '').trim();
  return raw || '30 days';
}

function paymentTermDays(value) {
  const raw = String(value || '').trim().toUpperCase();
  if (!raw || raw === 'CASH' || raw === 'IMMEDIATE') return 0;
  const match = raw.match(/(\d+)/);
  return match ? Number(match[1]) : 30;
}

function dueDateFrom(invoiceDate, terms) {
  const base = invoiceDate ? new Date(invoiceDate) : new Date();
  if (Number.isNaN(base.getTime())) return null;
  base.setDate(base.getDate() + paymentTermDays(terms));
  return base.toISOString().slice(0, 10);
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

function normalizeInwardLines(rawLines, isDraft) {
  return Array.isArray(rawLines)
    ? rawLines
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
          free_offer_enabled: Boolean(line.free_offer_enabled),
          free_offer_barcode: String(line.free_offer_barcode || '').trim().toUpperCase(),
          free_offer_product_name: normalizeProductName(line.free_offer_product_name),
          free_offer_qty_per_sale: parseMoney(line.free_offer_qty_per_sale) || 1,
          free_offer_total_qty: parseMoney(line.free_offer_total_qty),
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
}

function batchKey(barcode, batchNo = '', expiryDate = null) {
  const expiry = expiryDate ? new Date(expiryDate).toISOString().slice(0, 10) : '';
  return `${String(barcode || '').trim().toUpperCase()}|${String(batchNo || '').trim().toUpperCase()}|${expiry}`;
}

function stockQuantityForLine(line) {
  return (line.quantity + line.free_qty) * line.stock_conversion_factor;
}

function batchMetaForLine(line, inwardNo) {
  const stockQty = stockQuantityForLine(line);
  const basePurchasePrice = line.stock_conversion_factor > 0 ? line.purchase_price / line.stock_conversion_factor : line.purchase_price;
  return {
    barcode: line.barcode,
    product_name: line.product_name,
    hsn_code: line.hsn_code,
    gst_percent: line.gst_percent,
    batch_no: line.batch_no || '',
    expiry_date: line.expiry_date,
    inward_no: inwardNo,
    purchase_price: basePurchasePrice,
    mrp: line.mrp,
    stockQty
  };
}

async function applyPostedInwardStockDelta(connection, inwardNo, validLines) {
  const [oldBatches] = await connection.query(
    `SELECT barcode, batch_no, expiry_date, quantity_received, quantity_available
     FROM product_batches
     WHERE inward_no = ?
     FOR UPDATE`,
    [inwardNo]
  );

  const oldByKey = new Map(oldBatches.map((batch) => [batchKey(batch.barcode, batch.batch_no, batch.expiry_date), batch]));
  const newByKey = new Map();

  for (const line of validLines) {
    if (line.is_adjustment) continue;
    const meta = batchMetaForLine(line, inwardNo);
    const key = batchKey(meta.barcode, meta.batch_no, meta.expiry_date);
    const current = newByKey.get(key) || { ...meta, stockQty: 0 };
    current.stockQty += meta.stockQty;
    newByKey.set(key, current);
  }

  for (const [key, oldBatch] of oldByKey.entries()) {
    const oldReceived = parseMoney(oldBatch.quantity_received);
    const oldAvailable = parseMoney(oldBatch.quantity_available);
    const consumed = oldReceived - oldAvailable;
    const nextMeta = newByKey.get(key);
    const nextQty = nextMeta ? nextMeta.stockQty : 0;
    const delta = nextQty - oldReceived;

    if (consumed > 0.001 && delta < -0.001) {
      throw new Error(`Cannot reduce/remove ${oldBatch.barcode} batch ${oldBatch.batch_no || '-'}. Some quantity is already sold. You can add/increase only.`);
    }

    if (Math.abs(delta) <= 0.001) {
      newByKey.delete(key);
      continue;
    }

    if (delta < 0) {
      const reduceQty = Math.abs(delta);
      const [productResult] = await connection.query(
        `UPDATE products
         SET stock_qty = stock_qty - ?,
             updated_at = CURRENT_TIMESTAMP
         WHERE barcode = ? AND stock_qty >= ?`,
        [reduceQty, oldBatch.barcode, reduceQty]
      );
      if (productResult.affectedRows !== 1) {
        throw new Error(`Cannot reduce ${oldBatch.barcode}. Current stock is lower than reduce quantity.`);
      }
    } else {
      await connection.query(
        `UPDATE products
         SET stock_qty = stock_qty + ?,
             updated_at = CURRENT_TIMESTAMP
         WHERE barcode = ?`,
        [delta, oldBatch.barcode]
      );
    }

    if (nextQty <= 0.001) {
      await connection.query(
        `DELETE FROM product_batches
         WHERE inward_no = ? AND barcode = ? AND batch_no = ? AND (expiry_date <=> ?)`,
        [inwardNo, oldBatch.barcode, oldBatch.batch_no || '', oldBatch.expiry_date || null]
      );
    } else {
      await connection.query(
        `UPDATE product_batches
         SET quantity_received = ?, quantity_available = quantity_available + ?, updated_at = CURRENT_TIMESTAMP
         WHERE inward_no = ? AND barcode = ? AND batch_no = ? AND (expiry_date <=> ?)`,
        [nextQty, delta, inwardNo, oldBatch.barcode, oldBatch.batch_no || '', oldBatch.expiry_date || null]
      );
    }

    newByKey.delete(key);
  }

  for (const meta of newByKey.values()) {
    if (meta.stockQty <= 0) continue;
    await connection.query(
      `INSERT INTO product_batches
       (barcode, batch_no, expiry_date, inward_no, purchase_price, mrp, quantity_received, quantity_available)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [meta.barcode, meta.batch_no, meta.expiry_date, inwardNo, meta.purchase_price, meta.mrp, meta.stockQty, meta.stockQty]
    );
    const [productRows] = await connection.query(`SELECT barcode FROM products WHERE barcode = ? LIMIT 1`, [meta.barcode]);
    if (productRows.length) {
      await connection.query(
        `UPDATE products
         SET stock_qty = stock_qty + ?,
             updated_at = CURRENT_TIMESTAMP
         WHERE barcode = ?`,
        [meta.stockQty, meta.barcode]
      );
    } else {
      await connection.query(
        `INSERT INTO products
         (product_code, barcode, product_name, hsn_code, gst_percent, mrp, purchase_price, sale_price, wholesale_price, stock_qty)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          meta.barcode,
          meta.barcode,
          meta.product_name || meta.barcode,
          meta.hsn_code || '',
          meta.gst_percent || 0,
          meta.mrp || meta.purchase_price,
          meta.purchase_price,
          meta.purchase_price,
          meta.purchase_price,
          meta.stockQty
        ]
      );
    }
  }
}

async function reversePostedInward(connection, inwardNo) {
  const [batchRows] = await connection.query(
    `SELECT barcode, batch_no, expiry_date, quantity_received, quantity_available
     FROM product_batches
     WHERE inward_no = ?
     FOR UPDATE`,
    [inwardNo]
  );

  const consumedBatch = batchRows.find((batch) => parseMoney(batch.quantity_available) + 0.001 < parseMoney(batch.quantity_received));
  if (consumedBatch) {
    throw new Error(`Cannot edit/delete inward ${inwardNo}. Stock from batch ${consumedBatch.batch_no || '-'} has already been sold.`);
  }

  const [offerRows] = await connection.query(
    `SELECT id, free_qty_total, free_qty_remaining
     FROM batch_free_offers
     WHERE inward_no = ?
     FOR UPDATE`,
    [inwardNo]
  );
  const usedOffer = offerRows.find((offer) => parseMoney(offer.free_qty_remaining) + 0.001 < parseMoney(offer.free_qty_total));
  if (usedOffer) {
    throw new Error(`Cannot edit/delete inward ${inwardNo}. Free item offer has already been used in billing.`);
  }

  const stockByBarcode = batchRows.reduce((acc, batch) => {
    acc[batch.barcode] = (acc[batch.barcode] || 0) + parseMoney(batch.quantity_received);
    return acc;
  }, {});

  for (const [barcode, qty] of Object.entries(stockByBarcode)) {
    const [result] = await connection.query(
      `UPDATE products
       SET stock_qty = stock_qty - ?,
           updated_at = CURRENT_TIMESTAMP
       WHERE barcode = ? AND stock_qty >= ?`,
      [qty, barcode, qty]
    );
    if (result.affectedRows !== 1) {
      throw new Error(`Cannot reverse stock for ${barcode}. Current stock is lower than inward quantity.`);
    }
  }

  await connection.query(`DELETE FROM batch_free_offers WHERE inward_no = ?`, [inwardNo]);
  await connection.query(`DELETE FROM product_batches WHERE inward_no = ?`, [inwardNo]);
}

router.use(authenticate, authorize('SERVER', 'ADMIN'));

router.get('/suppliers', async (req, res) => {
  const search = String(req.query.search || '').trim();
  const like = `%${search}%`;
  const masterParams = search ? [like, like, like] : [];
  const historyParams = search ? [like, like, like] : [];

  try {
    const [masterRows] = await db.query(
      `SELECT id, supplier_name, supplier_address, supplier_gstin, supplier_phone,
              contact_person, payment_terms, account_holder_name, bank_name, bank_branch,
              bank_account_no, bank_ifsc, upi_id, is_active, created_at, updated_at
       FROM suppliers
       ${search ? 'WHERE supplier_name LIKE ? OR supplier_gstin LIKE ? OR supplier_phone LIKE ?' : ''}
       ORDER BY updated_at DESC, supplier_name ASC
       LIMIT 100`,
      masterParams
    );

    const [historyRows] = await db.query(
      `SELECT e.supplier_name, e.supplier_address, e.supplier_gstin, e.supplier_phone,
              e.supplier_invoice_no, e.supplier_invoice_date, e.created_at
       FROM inward_entries e
       INNER JOIN (
         SELECT MAX(id) AS id
         FROM inward_entries
         WHERE supplier_name <> ''
         ${search ? 'AND (supplier_name LIKE ? OR supplier_gstin LIKE ? OR supplier_phone LIKE ?)' : ''}
         GROUP BY UPPER(TRIM(supplier_name)), UPPER(TRIM(COALESCE(supplier_gstin, '')))
       ) latest ON latest.id = e.id
       ORDER BY e.id DESC
       LIMIT 100`,
      historyParams
    );

    const rowsByKey = new Map();
    for (const row of masterRows || []) {
      const key = `${String(row.supplier_name || '').trim().toUpperCase()}|${String(row.supplier_gstin || '').trim().toUpperCase()}`;
      rowsByKey.set(key, {
        id: row.id,
        name: row.supplier_name || '',
        address: row.supplier_address || '',
        gstin: row.supplier_gstin || '',
        phone: row.supplier_phone || '',
        contact_person: row.contact_person || '',
        payment_terms: row.payment_terms || '',
        account_holder_name: row.account_holder_name || '',
        bank_name: row.bank_name || '',
        bank_branch: row.bank_branch || '',
        bank_account_no: row.bank_account_no || '',
        bank_ifsc: row.bank_ifsc || '',
        upi_id: row.upi_id || '',
        is_active: Boolean(row.is_active),
        source: 'MASTER',
        last_invoice_no: '',
        last_invoice_date: '',
        last_used_at: row.updated_at || row.created_at || ''
      });
    }

    for (const row of historyRows || []) {
      const key = `${String(row.supplier_name || '').trim().toUpperCase()}|${String(row.supplier_gstin || '').trim().toUpperCase()}`;
      if (rowsByKey.has(key)) {
        const current = rowsByKey.get(key);
        rowsByKey.set(key, {
          ...current,
          last_invoice_no: row.supplier_invoice_no || current.last_invoice_no || '',
          last_invoice_date: row.supplier_invoice_date || current.last_invoice_date || '',
          last_used_at: row.created_at || current.last_used_at || ''
        });
        continue;
      }
      rowsByKey.set(key, {
        id: null,
        name: row.supplier_name || '',
        address: row.supplier_address || '',
        gstin: row.supplier_gstin || '',
        phone: row.supplier_phone || '',
        contact_person: '',
        payment_terms: '',
        account_holder_name: '',
        bank_name: '',
        bank_branch: '',
        bank_account_no: '',
        bank_ifsc: '',
        upi_id: '',
        is_active: true,
        source: 'HISTORY',
        last_invoice_no: row.supplier_invoice_no || '',
        last_invoice_date: row.supplier_invoice_date || '',
        last_used_at: row.created_at || ''
      });
    }

    res.json(Array.from(rowsByKey.values()).slice(0, 100));
  } catch (err) {
    console.error('Supplier master fetch failed:', err.message);
    res.status(500).json({ error: 'Unable to load suppliers.' });
  }
});

router.post('/suppliers', async (req, res) => {
  const supplier = req.body || {};
  const name = String(supplier.name || supplier.supplier_name || '').trim();
  const gstin = String(supplier.gstin || supplier.supplier_gstin || '').trim().toUpperCase();

  if (!name) {
    return res.status(400).json({ error: 'Supplier name is required.' });
  }

  const values = {
    address: String(supplier.address || supplier.supplier_address || '').trim(),
    phone: String(supplier.phone || supplier.supplier_phone || '').trim(),
    contact_person: String(supplier.contact_person || '').trim(),
    payment_terms: String(supplier.payment_terms || '').trim(),
    account_holder_name: String(supplier.account_holder_name || '').trim(),
    bank_name: String(supplier.bank_name || '').trim(),
    bank_branch: String(supplier.bank_branch || '').trim(),
    bank_account_no: String(supplier.bank_account_no || '').trim(),
    bank_ifsc: String(supplier.bank_ifsc || '').trim().toUpperCase(),
    upi_id: String(supplier.upi_id || '').trim()
  };

  try {
    const [result] = await db.query(
      `INSERT INTO suppliers
       (supplier_name, supplier_address, supplier_gstin, supplier_phone, contact_person, payment_terms,
        account_holder_name, bank_name, bank_branch, bank_account_no, bank_ifsc, upi_id, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         supplier_address = VALUES(supplier_address),
         supplier_phone = VALUES(supplier_phone),
         contact_person = VALUES(contact_person),
         payment_terms = VALUES(payment_terms),
         account_holder_name = VALUES(account_holder_name),
         bank_name = VALUES(bank_name),
         bank_branch = VALUES(bank_branch),
         bank_account_no = VALUES(bank_account_no),
         bank_ifsc = VALUES(bank_ifsc),
         upi_id = VALUES(upi_id),
         is_active = 1,
         updated_at = CURRENT_TIMESTAMP`,
      [
        name,
        values.address,
        gstin,
        values.phone,
        values.contact_person,
        values.payment_terms,
        values.account_holder_name,
        values.bank_name,
        values.bank_branch,
        values.bank_account_no,
        values.bank_ifsc,
        values.upi_id,
        req.user?.username || ''
      ]
    );

    await writeAuditLog({
      user: req.user,
      action: result.insertId ? 'SUPPLIER_CREATED' : 'SUPPLIER_UPDATED',
      entityType: 'SUPPLIER',
      entityId: `${name}|${gstin}`,
      details: { name, gstin, phone: values.phone }
    });

    res.json({ success: true, id: result.insertId || null, name, gstin, ...values });
  } catch (err) {
    console.error('Supplier save failed:', err.message);
    res.status(500).json({ error: 'Unable to save supplier.' });
  }
});

router.get('/supplier-dues', async (req, res) => {
  const supplier = String(req.query.supplier || '').trim();
  const status = String(req.query.status || 'OPEN').trim().toUpperCase();
  const clauses = ["posting_status = 'POSTED'"];
  const params = [];

  if (supplier) {
    clauses.push('supplier_name LIKE ?');
    params.push(`%${supplier}%`);
  }
  if (status === 'OPEN') {
    clauses.push('due_amount > 0.01');
  } else if (['PAID', 'PARTIAL', 'DUE', 'OVERDUE'].includes(status)) {
    clauses.push('payment_status = ?');
    params.push(status);
  }

  try {
    await db.query(
      `UPDATE inward_entries
       SET payment_status = 'OVERDUE'
       WHERE posting_status = 'POSTED'
         AND due_amount > 0.01
         AND due_date IS NOT NULL
         AND due_date < CURDATE()
         AND payment_status <> 'OVERDUE'`
    );

    const [rows] = await db.query(
      `SELECT id, inward_no, supplier_name, supplier_gstin, supplier_phone,
              supplier_invoice_no, supplier_invoice_date, payment_mode, payment_terms,
              due_date, grand_total, paid_amount, due_amount, payment_status, created_at
       FROM inward_entries
       WHERE ${clauses.join(' AND ')}
       ORDER BY due_date IS NULL ASC, due_date ASC, id DESC
       LIMIT 300`,
      params
    );

    const summary = rows.reduce((acc, row) => {
      acc.total_due += Number(row.due_amount || 0);
      acc.total_purchase += Number(row.grand_total || 0);
      acc.overdue_count += row.payment_status === 'OVERDUE' ? 1 : 0;
      return acc;
    }, { total_due: 0, total_purchase: 0, overdue_count: 0, bill_count: rows.length });

    res.json({ rows, summary });
  } catch (err) {
    console.error('Supplier dues fetch failed:', err.message);
    res.status(500).json({ error: 'Unable to load supplier dues.' });
  }
});

router.post('/supplier-payments', async (req, res) => {
  const inwardNo = String(req.body?.inward_no || '').trim();
  const amount = parseMoney(req.body?.amount);
  const paymentDate = req.body?.payment_date || new Date().toISOString().slice(0, 10);
  const paymentMode = normalizeSupplierPaymentMode(req.body?.payment_mode);
  const referenceNo = String(req.body?.reference_no || '').trim();
  const notes = String(req.body?.notes || '').trim();

  if (!inwardNo) return res.status(400).json({ error: 'Inward bill is required.' });
  if (amount <= 0) return res.status(400).json({ error: 'Payment amount must be greater than zero.' });

  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();
    const [entryRows] = await connection.query(
      `SELECT inward_no, supplier_name, supplier_gstin, grand_total, paid_amount, due_amount, due_date
       FROM inward_entries
       WHERE inward_no = ? AND posting_status = 'POSTED'
       FOR UPDATE`,
      [inwardNo]
    );
    const entry = entryRows[0];
    if (!entry) throw new Error('Posted inward bill not found.');
    const currentDue = Number(entry.due_amount || 0);
    if (amount > currentDue + 0.01) {
      throw new Error(`Payment cannot be more than due amount ${currentDue.toFixed(2)}.`);
    }

    const paidAmount = Number(entry.paid_amount || 0) + amount;
    const dueAmount = Math.max(Number(entry.grand_total || 0) - paidAmount, 0);
    const paymentStatus = dueAmount <= 0.01
      ? 'PAID'
      : paidAmount > 0
        ? 'PARTIAL'
        : paymentStatusFor(dueAmount, entry.due_date);

    const [paymentResult] = await connection.query(
      `INSERT INTO supplier_payments
       (inward_no, supplier_name, supplier_gstin, payment_date, amount, payment_mode, reference_no, notes, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [inwardNo, entry.supplier_name, entry.supplier_gstin || '', paymentDate, amount, paymentMode, referenceNo, notes.slice(0, 255), req.user?.username || '']
    );

    await connection.query(
      `UPDATE inward_entries
       SET paid_amount = ?, due_amount = ?, payment_status = ?
       WHERE inward_no = ?`,
      [paidAmount, dueAmount, paymentStatus, inwardNo]
    );

    await writeAuditLog({
      user: req.user,
      action: 'SUPPLIER_PAYMENT_RECORDED',
      entityType: 'SUPPLIER_PAYMENT',
      entityId: String(paymentResult.insertId),
      details: { inward_no: inwardNo, supplier: entry.supplier_name, amount, paymentMode, referenceNo },
      connection
    });

    await connection.commit();
    res.json({ success: true, id: paymentResult.insertId, inward_no: inwardNo, paid_amount: paidAmount, due_amount: dueAmount, payment_status: paymentStatus });
  } catch (err) {
    await connection.rollback();
    console.error('Supplier payment save failed:', err.message);
    res.status(400).json({ error: err.message || 'Unable to record supplier payment.' });
  } finally {
    connection.release();
  }
});

router.get('/supplier-ledger', async (req, res) => {
  const supplier = String(req.query.supplier || '').trim();
  if (supplier.length < 2) return res.status(400).json({ error: 'Supplier search is required.' });
  const like = `%${supplier}%`;

  try {
    const [billRows] = await db.query(
      `SELECT inward_no, supplier_name, supplier_invoice_no, supplier_invoice_date, created_at,
              grand_total, paid_amount, due_amount, payment_status, due_date
       FROM inward_entries
       WHERE posting_status = 'POSTED' AND supplier_name LIKE ?
       ORDER BY COALESCE(supplier_invoice_date, DATE(created_at)) ASC, id ASC
       LIMIT 300`,
      [like]
    );
    const [paymentRows] = await db.query(
      `SELECT id, inward_no, supplier_name, payment_date, amount, payment_mode, reference_no, notes, created_at
       FROM supplier_payments
       WHERE supplier_name LIKE ?
       ORDER BY payment_date ASC, id ASC
       LIMIT 500`,
      [like]
    );

    const entries = [
      ...billRows.map((row) => ({
        type: 'BILL',
        date: row.supplier_invoice_date || row.created_at,
        inward_no: row.inward_no,
        reference_no: row.supplier_invoice_no || '',
        description: `Purchase bill ${row.supplier_invoice_no || row.inward_no}`,
        debit: Number(row.grand_total || 0),
        credit: 0,
        status: row.payment_status,
        due_date: row.due_date
      })),
      ...paymentRows.map((row) => ({
        type: 'PAYMENT',
        date: row.payment_date || row.created_at,
        inward_no: row.inward_no,
        reference_no: row.reference_no || '',
        description: `${row.payment_mode} payment${row.notes ? ` - ${row.notes}` : ''}`,
        debit: 0,
        credit: Number(row.amount || 0),
        status: '',
        due_date: ''
      }))
    ].sort((a, b) => new Date(a.date) - new Date(b.date));

    let balance = 0;
    const ledger = entries.map((entry) => {
      balance += entry.debit - entry.credit;
      return { ...entry, balance };
    });

    res.json({
      supplier,
      summary: {
        total_purchase: billRows.reduce((sum, row) => sum + Number(row.grand_total || 0), 0),
        total_paid: paymentRows.reduce((sum, row) => sum + Number(row.amount || 0), 0),
        balance
      },
      rows: ledger
    });
  } catch (err) {
    console.error('Supplier ledger fetch failed:', err.message);
    res.status(500).json({ error: 'Unable to load supplier ledger.' });
  }
});

router.get('/purchase-orders', async (req, res) => {
  try {
    const status = String(req.query.status || '').trim().toUpperCase();
    const supplier = String(req.query.supplier || '').trim();
    const clauses = [];
    const params = [];

    if (status && status !== 'ALL') {
      clauses.push('status = ?');
      params.push(status);
    }
    if (supplier) {
      clauses.push('supplier_name LIKE ?');
      params.push(`%${supplier}%`);
    }

    const whereSql = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const [rows] = await db.query(
      `SELECT *
       FROM purchase_orders
       ${whereSql}
       ORDER BY updated_at DESC, id DESC
       LIMIT 100`,
      params
    );
    res.json(rows || []);
  } catch (err) {
    console.error('Purchase order list failed:', err.message);
    res.status(500).json({ error: 'Unable to load purchase orders.' });
  }
});

router.get('/purchase-orders/:poNo', async (req, res) => {
  try {
    const poNo = String(req.params.poNo || '').trim();
    const [orderRows] = await db.query(`SELECT * FROM purchase_orders WHERE po_no = ? LIMIT 1`, [poNo]);
    if (!orderRows.length) return res.status(404).json({ error: 'Purchase order not found.' });

    const [itemRows] = await db.query(
      `SELECT * FROM purchase_order_items WHERE po_no = ? ORDER BY id ASC`,
      [poNo]
    );
    res.json({ order: orderRows[0], items: itemRows || [] });
  } catch (err) {
    console.error('Purchase order detail failed:', err.message);
    res.status(500).json({ error: 'Unable to load purchase order.' });
  }
});

router.post('/purchase-orders', async (req, res) => {
  const supplier = req.body?.supplier || {};
  const lines = Array.isArray(req.body?.lines) ? req.body.lines : [];
  const status = String(req.body?.status || 'DRAFT').trim().toUpperCase() === 'ORDERED' ? 'ORDERED' : 'DRAFT';
  const expectedDate = req.body?.expected_date || null;
  const notes = String(req.body?.notes || '').trim();

  if (!String(supplier.name || '').trim()) {
    return res.status(400).json({ error: 'Supplier name is required for purchase order.' });
  }

  const validLines = lines
    .map((line) => ({
      barcode: String(line.barcode || '').trim().toUpperCase(),
      product_name: String(line.product_name || line.product || '').trim(),
      current_stock: parseMoney(line.current_stock),
      min_stock_alert: parseMoney(line.min_stock_alert),
      order_qty: parseMoney(line.order_qty),
      purchase_price: parseMoney(line.purchase_price),
      note: String(line.note || '').trim()
    }))
    .filter((line) => line.barcode && line.product_name && line.order_qty > 0);

  if (!validLines.length) {
    return res.status(400).json({ error: 'Add at least one product with order quantity.' });
  }

  const poNo = purchaseOrderNo();
  const totalQty = validLines.reduce((sum, line) => sum + line.order_qty, 0);
  const estimatedTotal = validLines.reduce((sum, line) => sum + (line.order_qty * line.purchase_price), 0);
  const connection = await db.getConnection();

  try {
    await connection.beginTransaction();
    await connection.query(
      `INSERT INTO purchase_orders
       (po_no, supplier_name, supplier_address, supplier_gstin, supplier_phone, expected_date, status, item_count, total_qty, estimated_total, notes, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        poNo,
        String(supplier.name || '').trim(),
        String(supplier.address || '').trim(),
        String(supplier.gstin || '').trim().toUpperCase(),
        String(supplier.phone || '').trim(),
        expectedDate || null,
        status,
        validLines.length,
        totalQty,
        estimatedTotal,
        notes.slice(0, 255),
        req.user?.username || ''
      ]
    );

    for (const line of validLines) {
      await connection.query(
        `INSERT INTO purchase_order_items
         (po_no, barcode, product_name, current_stock, min_stock_alert, order_qty, purchase_price, line_total, note)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          poNo,
          line.barcode,
          line.product_name,
          line.current_stock,
          line.min_stock_alert,
          line.order_qty,
          line.purchase_price,
          line.order_qty * line.purchase_price,
          line.note.slice(0, 255)
        ]
      );
    }

    await writeAuditLog({
      user: req.user,
      action: 'PURCHASE_ORDER_CREATED',
      entityType: 'PURCHASE_ORDER',
      entityId: poNo,
      details: { status, supplier: supplier.name, item_count: validLines.length, total_qty: totalQty, estimated_total: estimatedTotal },
      connection
    });

    await connection.commit();
    res.json({ success: true, po_no: poNo, status, item_count: validLines.length, total_qty: totalQty, estimated_total: estimatedTotal });
  } catch (err) {
    await connection.rollback();
    console.error('Purchase order save failed:', err.message);
    res.status(500).json({ error: 'Unable to save purchase order.' });
  } finally {
    connection.release();
  }
});

router.post('/purchase-orders/:poNo/status', async (req, res) => {
  const poNo = String(req.params.poNo || '').trim();
  const status = String(req.body?.status || '').trim().toUpperCase();
  const allowedStatuses = new Set(['DRAFT', 'ORDERED', 'RECEIVED', 'CANCELLED']);
  if (!allowedStatuses.has(status)) return res.status(400).json({ error: 'Invalid purchase order status.' });

  try {
    const [result] = await db.query(
      `UPDATE purchase_orders SET status = ? WHERE po_no = ?`,
      [status, poNo]
    );
    if (result.affectedRows !== 1) return res.status(404).json({ error: 'Purchase order not found.' });

    await writeAuditLog({
      user: req.user,
      action: 'PURCHASE_ORDER_STATUS_UPDATED',
      entityType: 'PURCHASE_ORDER',
      entityId: poNo,
      details: { status }
    });
    res.json({ success: true, po_no: poNo, status });
  } catch (err) {
    console.error('Purchase order status update failed:', err.message);
    res.status(500).json({ error: 'Unable to update purchase order status.' });
  }
});

router.get('/recent', async (_req, res) => {
  try {
    const [rows] = await db.query(
      `SELECT id, inward_no, supplier_name, supplier_invoice_no, supplier_invoice_date, payment_mode,
              payment_terms, due_date, paid_amount, due_amount, payment_status,
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
              payment_terms, due_date, paid_amount, due_amount, payment_status,
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
    const [masterRows] = await db.query(
      `SELECT supplier_name, supplier_address, supplier_gstin, supplier_phone,
              contact_person, payment_terms, account_holder_name, bank_name, bank_branch,
              bank_account_no, bank_ifsc, upi_id, updated_at
       FROM suppliers
       WHERE is_active = 1
         AND (supplier_name LIKE ? OR supplier_gstin LIKE ? OR supplier_phone LIKE ?)
       ORDER BY updated_at DESC, supplier_name ASC
       LIMIT 12`,
      [like, like, like]
    );

    const [historyRows] = await db.query(
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

    const rowsByKey = new Map();
    for (const row of masterRows || []) {
      const key = `${String(row.supplier_name || '').trim().toUpperCase()}|${String(row.supplier_gstin || '').trim().toUpperCase()}`;
      rowsByKey.set(key, {
        name: row.supplier_name || '',
        address: row.supplier_address || '',
        gstin: row.supplier_gstin || '',
        phone: row.supplier_phone || '',
        contact_person: row.contact_person || '',
        payment_terms: row.payment_terms || '',
        account_holder_name: row.account_holder_name || '',
        bank_name: row.bank_name || '',
        bank_branch: row.bank_branch || '',
        bank_account_no: row.bank_account_no || '',
        bank_ifsc: row.bank_ifsc || '',
        upi_id: row.upi_id || '',
        last_invoice_no: '',
        last_invoice_date: '',
        last_used_at: row.updated_at || '',
        source: 'MASTER'
      });
    }
    for (const row of historyRows || []) {
      const key = `${String(row.supplier_name || '').trim().toUpperCase()}|${String(row.supplier_gstin || '').trim().toUpperCase()}`;
      if (rowsByKey.has(key)) {
        const current = rowsByKey.get(key);
        rowsByKey.set(key, {
          ...current,
          last_invoice_no: row.supplier_invoice_no || current.last_invoice_no || '',
          last_invoice_date: row.supplier_invoice_date || current.last_invoice_date || '',
          last_used_at: row.created_at || current.last_used_at || ''
        });
        continue;
      }
      rowsByKey.set(key, {
        name: row.supplier_name || '',
        address: row.supplier_address || '',
        gstin: row.supplier_gstin || '',
        phone: row.supplier_phone || '',
        contact_person: '',
        payment_terms: '',
        account_holder_name: '',
        bank_name: '',
        bank_branch: '',
        bank_account_no: '',
        bank_ifsc: '',
        upi_id: '',
        last_invoice_no: row.supplier_invoice_no || '',
        last_invoice_date: row.supplier_invoice_date || '',
        last_used_at: row.created_at || '',
        source: 'HISTORY'
      });
    }

    res.json(Array.from(rowsByKey.values()).slice(0, 12));
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
              supplier_invoice_no, supplier_invoice_date, payment_mode, payment_terms, due_date,
              paid_amount, due_amount, payment_status, item_count, total_qty, taxable_total,
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
              batch_no, expiry_date, mrp, free_qty, free_offer_enabled, free_offer_barcode, free_offer_product_name,
              free_offer_qty_per_sale, free_offer_total_qty, quantity, taxable_amount, gst_amount, cgst_amount, sgst_amount,
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
              supplier_invoice_no, supplier_invoice_date, payment_mode, payment_terms, due_date,
              paid_amount, due_amount, payment_status, item_count, total_qty, taxable_total,
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
              batch_no, expiry_date, mrp, free_qty, free_offer_enabled, free_offer_barcode, free_offer_product_name,
              free_offer_qty_per_sale, free_offer_total_qty, quantity, taxable_amount, gst_amount, cgst_amount, sgst_amount,
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
  const replaceInwardId = Number(req.body?.replace_inward_id || 0);

  if (!supplier.name || !String(supplier.name).trim()) {
    return res.status(400).json({ error: 'Supplier name is required.' });
  }

  const validLines = normalizeInwardLines(lines, isDraft);
  const pendingLines = !isDraft && Number(req.body?.source_draft_id || 0) > 0
    ? normalizeInwardLines(req.body?.pending_lines || [], true)
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

  const invalidFreeOfferLine = !isDraft && validLines.find((line) => (
    line.free_offer_enabled
    && (!line.batch_no || !line.free_offer_barcode || !line.free_offer_product_name || line.free_offer_total_qty <= 0)
  ));
  if (invalidFreeOfferLine) {
    return res.status(400).json({ error: 'Free item offer needs batch code, free counter code/name, and total free item count.' });
  }

  const invalidPendingLine = pendingLines.find((line) => (
    !line.product_name
    || !line.barcode
    || line.quantity <= 0
    || (!line.is_adjustment && line.purchase_price < 0)
  ));
  if (invalidPendingLine) {
    return res.status(400).json({ error: 'Pending invoice rows need product and quantity.' });
  }

  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();
    let finalInwardNo = inwardNo();
    let entryResult = null;
    let replacingEntry = null;
    let skipStockMutationForReplacement = false;

    if (replaceInwardId > 0 && isDraft) {
      const [replaceRows] = await connection.query(
        `SELECT id, inward_no, posting_status
         FROM inward_entries
         WHERE id = ?
         FOR UPDATE`,
        [replaceInwardId]
      );
      replacingEntry = replaceRows[0];
      if (!replacingEntry) {
        throw new Error('Pending inward bill selected for edit was not found.');
      }
      if (replacingEntry.posting_status !== 'DRAFT') {
        throw new Error('Only pending inward bills can be updated as draft.');
      }
      finalInwardNo = replacingEntry.inward_no;
      await connection.query(`DELETE FROM inward_items WHERE inward_no = ?`, [finalInwardNo]);
      await connection.query(
        `UPDATE inward_entries
         SET supplier_name = ?, supplier_address = ?, supplier_gstin = ?, supplier_phone = ?,
             supplier_invoice_no = ?, supplier_invoice_date = ?, payment_mode = ?, item_count = 0,
             total_qty = 0, taxable_total = 0, gst_total = 0, total_cgst = 0, total_sgst = 0,
             total_igst = 0, grand_total = 0, tax_type = ?, posting_status = 'DRAFT', created_by = ?
         WHERE inward_no = ?`,
        [
          String(supplier.name || '').trim(),
          String(supplier.address || '').trim(),
          String(supplier.gstin || '').trim().toUpperCase(),
          String(supplier.phone || '').trim(),
          String(supplier.invoice_no || '').trim(),
          supplier.invoice_date || null,
          paymentMode,
          taxType,
          req.user.username,
          finalInwardNo
        ]
      );
      entryResult = { insertId: replacingEntry.id };
    }

    if (replaceInwardId > 0 && !isDraft) {
      const [replaceRows] = await connection.query(
        `SELECT id, inward_no, posting_status
         FROM inward_entries
         WHERE id = ?
         FOR UPDATE`,
        [replaceInwardId]
      );
      replacingEntry = replaceRows[0];
      if (!replacingEntry) {
        throw new Error('Inward bill selected for edit was not found.');
      }
      if (replacingEntry.posting_status !== 'POSTED') {
        throw new Error('Only posted inward bills can be replaced from edit mode.');
      }
      finalInwardNo = replacingEntry.inward_no;
      const [soldBatchRows] = await connection.query(
        `SELECT COUNT(*) AS sold_count
         FROM product_batches
         WHERE inward_no = ? AND quantity_available < quantity_received`,
        [finalInwardNo]
      );
      skipStockMutationForReplacement = Number(soldBatchRows[0]?.sold_count || 0) > 0;
      if (skipStockMutationForReplacement) {
        await applyPostedInwardStockDelta(connection, finalInwardNo, validLines);
      } else {
        await reversePostedInward(connection, finalInwardNo);
      }
      await connection.query(`DELETE FROM inward_items WHERE inward_no = ?`, [finalInwardNo]);
      await connection.query(
        `UPDATE inward_entries
         SET supplier_name = ?, supplier_address = ?, supplier_gstin = ?, supplier_phone = ?,
             supplier_invoice_no = ?, supplier_invoice_date = ?, payment_mode = ?, item_count = 0,
             total_qty = 0, taxable_total = 0, gst_total = 0, total_cgst = 0, total_sgst = 0,
             total_igst = 0, grand_total = 0, tax_type = ?, posting_status = 'POSTED', created_by = ?
         WHERE inward_no = ?`,
        [
          String(supplier.name || '').trim(),
          String(supplier.address || '').trim(),
          String(supplier.gstin || '').trim().toUpperCase(),
          String(supplier.phone || '').trim(),
          String(supplier.invoice_no || '').trim(),
          supplier.invoice_date || null,
          paymentMode,
          taxType,
          req.user.username,
          finalInwardNo
        ]
      );
      entryResult = { insertId: replacingEntry.id };
    }

    let totalQty = 0;
    let taxableTotal = 0;
    let gstTotal = 0;
    let cgstTotal = 0;
    let sgstTotal = 0;
    let igstTotal = 0;
    let grandTotal = 0;

    if (!entryResult) {
      [entryResult] = await connection.query(
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
    }

    for (const line of validLines) {
      const calculated = calculateInwardLine(line, taxType);
      const stockQty = (line.is_adjustment || isDraft) ? 0 : (line.quantity + line.free_qty) * line.stock_conversion_factor;
      const basePurchasePrice = line.stock_conversion_factor > 0 ? line.purchase_price / line.stock_conversion_factor : line.purchase_price;
      const hasFreeOffer = Boolean(line.free_offer_enabled && line.free_offer_barcode && line.free_offer_product_name && line.free_offer_total_qty > 0);

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
          batch_no, expiry_date, mrp, free_qty, free_offer_enabled, free_offer_barcode, free_offer_product_name,
          free_offer_qty_per_sale, free_offer_total_qty, quantity, taxable_amount, gst_amount, cgst_amount, sgst_amount, igst_amount, total_amount)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
          hasFreeOffer ? 1 : 0,
          hasFreeOffer ? line.free_offer_barcode : '',
          hasFreeOffer ? line.free_offer_product_name : '',
          hasFreeOffer ? line.free_offer_qty_per_sale : 1,
          hasFreeOffer ? line.free_offer_total_qty : 0,
          line.quantity,
          calculated.taxable,
          calculated.gstAmount,
          calculated.cgstAmount,
          calculated.sgstAmount,
          calculated.igstAmount,
          calculated.lineTotal
        ]
      );

      if (!line.is_adjustment && !isDraft && !skipStockMutationForReplacement) {
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
                 purchase_price = ?,
                 updated_at = CURRENT_TIMESTAMP
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

        if (hasFreeOffer) {
          await connection.query(
            `INSERT INTO batch_free_offers
             (trigger_barcode, trigger_batch_no, trigger_expiry_date, inward_no, free_barcode, free_product_name,
              free_qty_per_sale, free_qty_total, free_qty_remaining, is_active)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
             ON DUPLICATE KEY UPDATE
               inward_no = VALUES(inward_no),
               free_product_name = VALUES(free_product_name),
               free_qty_per_sale = VALUES(free_qty_per_sale),
               free_qty_total = free_qty_total + VALUES(free_qty_total),
               free_qty_remaining = free_qty_remaining + VALUES(free_qty_remaining),
               is_active = 1`,
            [
              line.barcode,
              line.batch_no || '',
              line.expiry_date,
              finalInwardNo,
              line.free_offer_barcode,
              line.free_offer_product_name,
              line.free_offer_qty_per_sale,
              line.free_offer_total_qty,
              line.free_offer_total_qty
            ]
          );
        }
      }
    }

    const paymentTerms = normalizePaymentTerms(req.body?.payment_terms || supplier.payment_terms);
    const invoiceDate = supplier.invoice_date || null;
    const dueDate = isDraft
      ? null
      : (req.body?.due_date || supplier.due_date || dueDateFrom(invoiceDate, paymentTerms));
    const requestedPaidAmount = parseMoney(req.body?.paid_amount ?? supplier.paid_amount);
    const paidAmount = isDraft
      ? 0
      : paymentMode === 'Cash'
        ? grandTotal
        : Math.min(Math.max(requestedPaidAmount, 0), grandTotal);
    const dueAmount = isDraft ? 0 : Math.max(grandTotal - paidAmount, 0);
    const paymentStatus = isDraft
      ? 'DUE'
      : paidAmount > 0 && dueAmount > 0
        ? 'PARTIAL'
        : paymentStatusFor(dueAmount, dueDate);

    await connection.query(
      `UPDATE inward_entries
       SET item_count = ?, total_qty = ?, taxable_total = ?, gst_total = ?,
           total_cgst = ?, total_sgst = ?, total_igst = ?, grand_total = ?,
           payment_terms = ?, due_date = ?, paid_amount = ?, due_amount = ?, payment_status = ?
       WHERE inward_no = ?`,
      [
        validLines.length,
        totalQty,
        taxableTotal,
        gstTotal,
        cgstTotal,
        sgstTotal,
        igstTotal,
        grandTotal,
        paymentTerms,
        dueDate,
        paidAmount,
        dueAmount,
        paymentStatus,
        finalInwardNo
      ]
    );

    await writeAuditLog({
      user: req.user,
      action: replacingEntry ? 'INWARD_UPDATED' : 'INWARD_CREATED',
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

    const sourceDraftId = Number(req.body?.source_draft_id || 0);
    if (!isDraft && sourceDraftId > 0) {
      if (pendingLines.length) {
        const [draftRows] = await connection.query(
          `SELECT id, inward_no
           FROM inward_entries
           WHERE id = ? AND posting_status = 'DRAFT'
           FOR UPDATE`,
          [sourceDraftId]
        );
        const draftEntry = draftRows[0];
        if (!draftEntry) {
          throw new Error('Pending inward bill selected for remaining rows was not found.');
        }

        await connection.query(`DELETE FROM inward_items WHERE inward_no = ?`, [draftEntry.inward_no]);
        await connection.query(
          `UPDATE inward_entries
           SET supplier_name = ?, supplier_address = ?, supplier_gstin = ?, supplier_phone = ?,
               supplier_invoice_no = ?, supplier_invoice_date = ?, payment_mode = ?, item_count = 0,
               total_qty = 0, taxable_total = 0, gst_total = 0, total_cgst = 0, total_sgst = 0,
               total_igst = 0, grand_total = 0, tax_type = ?, posting_status = 'DRAFT', created_by = ?
           WHERE inward_no = ?`,
          [
            String(supplier.name || '').trim(),
            String(supplier.address || '').trim(),
            String(supplier.gstin || '').trim().toUpperCase(),
            String(supplier.phone || '').trim(),
            String(supplier.invoice_no || '').trim(),
            supplier.invoice_date || null,
            paymentMode,
            taxType,
            req.user.username,
            draftEntry.inward_no
          ]
        );

        let pendingTaxableTotal = 0;
        let pendingGstTotal = 0;
        let pendingCgstTotal = 0;
        let pendingSgstTotal = 0;
        let pendingIgstTotal = 0;
        let pendingGrandTotal = 0;

        for (const line of pendingLines) {
          const calculated = calculateInwardLine(line, taxType);
          const hasFreeOffer = Boolean(line.free_offer_enabled && line.free_offer_barcode && line.free_offer_product_name && line.free_offer_total_qty > 0);

          pendingTaxableTotal += calculated.taxable;
          pendingGstTotal += calculated.gstAmount;
          pendingCgstTotal += calculated.cgstAmount;
          pendingSgstTotal += calculated.sgstAmount;
          pendingIgstTotal += calculated.igstAmount;
          pendingGrandTotal += calculated.lineTotal;

          await connection.query(
            `INSERT INTO inward_items
             (inward_no, barcode, product_name, hsn_code, gst_percent, purchase_price, discount_percent,
              discount_type, discount_amount, scheme, scheme_type, scheme_value, scheme_amount,
              batch_no, expiry_date, mrp, free_qty, free_offer_enabled, free_offer_barcode, free_offer_product_name,
              free_offer_qty_per_sale, free_offer_total_qty, quantity, taxable_amount, gst_amount, cgst_amount, sgst_amount, igst_amount, total_amount)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              draftEntry.inward_no,
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
              hasFreeOffer ? 1 : 0,
              hasFreeOffer ? line.free_offer_barcode : '',
              hasFreeOffer ? line.free_offer_product_name : '',
              hasFreeOffer ? line.free_offer_qty_per_sale : 1,
              hasFreeOffer ? line.free_offer_total_qty : 0,
              line.quantity,
              calculated.taxable,
              calculated.gstAmount,
              calculated.cgstAmount,
              calculated.sgstAmount,
              calculated.igstAmount,
              calculated.lineTotal
            ]
          );
        }

        await connection.query(
          `UPDATE inward_entries
           SET item_count = ?, total_qty = 0, taxable_total = ?, gst_total = ?,
               total_cgst = ?, total_sgst = ?, total_igst = ?, grand_total = ?
           WHERE inward_no = ?`,
          [
            pendingLines.length,
            pendingTaxableTotal,
            pendingGstTotal,
            pendingCgstTotal,
            pendingSgstTotal,
            pendingIgstTotal,
            pendingGrandTotal,
            draftEntry.inward_no
          ]
        );
      } else {
        await connection.query(
          `DELETE FROM inward_entries WHERE id = ? AND posting_status = 'DRAFT'`,
          [sourceDraftId]
        );
      }
    }

    await connection.commit();
    res.json({
      success: true,
      id: entryResult.insertId,
      serial_no: entryResult.insertId,
      inward_no: finalInwardNo,
      item_count: validLines.length,
      pending_item_count: pendingLines.length,
      total_qty: totalQty,
      payment_mode: paymentMode,
      payment_terms: paymentTerms,
      due_date: dueDate,
      paid_amount: paidAmount,
      due_amount: dueAmount,
      payment_status: paymentStatus,
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

router.delete('/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ error: 'Valid inward S.No is required.' });
  }

  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();
    const [entryRows] = await connection.query(
      `SELECT id, inward_no, posting_status
       FROM inward_entries
       WHERE id = ?
       FOR UPDATE`,
      [id]
    );
    const entry = entryRows[0];
    if (!entry) {
      await connection.rollback();
      return res.status(404).json({ error: 'Inward bill not found.' });
    }

    if (entry.posting_status === 'POSTED') {
      await reversePostedInward(connection, entry.inward_no);
    }

    await connection.query(`DELETE FROM inward_entries WHERE id = ?`, [id]);
    await writeAuditLog({
      user: req.user,
      action: 'INWARD_DELETED',
      entityType: 'INWARD',
      entityId: entry.inward_no,
      details: { postingStatus: entry.posting_status },
      connection
    });
    await connection.commit();
    res.json({ success: true, inward_no: entry.inward_no });
  } catch (err) {
    await connection.rollback();
    console.error('Inward delete failed:', err.message);
    res.status(500).json({ error: err.message || 'Unable to delete inward bill.' });
  } finally {
    connection.release();
  }
});

module.exports = router;
