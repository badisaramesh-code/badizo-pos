const express = require('express');
const crypto = require('crypto');
const db = require('../config/db');
const { authenticate } = require('../middleware/auth');

const router = express.Router();
router.use(authenticate);

function passwordMatches(user, password) {
  const stored = String(user?.password_hash || '');
  const [salt, expected] = stored.split(':');
  if (!salt || !expected) return false;
  const actual = crypto.pbkdf2Sync(String(password || ''), salt, 100000, 64, 'sha512').toString('hex');
  const actualBuffer = Buffer.from(actual, 'hex');
  const expectedBuffer = Buffer.from(expected, 'hex');
  return actualBuffer.length === expectedBuffer.length && crypto.timingSafeEqual(actualBuffer, expectedBuffer);
}

function numberValue(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function cleanText(value, maxLength = 255) {
  return String(value || '').trim().slice(0, maxLength);
}

async function verifySupervisor(connection, approval = {}) {
  const username = cleanText(approval.username, 100);
  const password = String(approval.password || '');
  if (!username || !password) {
    const error = new Error('Admin username and password are required for quotation.');
    error.status = 400;
    throw error;
  }
  const [rows] = await connection.query(
    `SELECT id, username, password_hash, role, is_active FROM users WHERE username = ? LIMIT 1`,
    [username]
  );
  const supervisor = rows[0];
  if (!supervisor || !supervisor.is_active || !['SERVER', 'ADMIN'].includes(supervisor.role) || !passwordMatches(supervisor, password)) {
    const error = new Error('Quotation approval failed. Use an active Admin or Server login.');
    error.status = 401;
    throw error;
  }
  return supervisor;
}

async function nextQuotationNumber(connection) {
  const sequenceDate = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
  await connection.query(
    `INSERT IGNORE INTO quotation_sequences (sequence_date, last_number) VALUES (?, 0)`,
    [sequenceDate]
  );
  const [rows] = await connection.query(
    `SELECT last_number FROM quotation_sequences WHERE sequence_date = ? FOR UPDATE`,
    [sequenceDate]
  );
  const nextNumber = numberValue(rows[0]?.last_number) + 1;
  await connection.query(
    `UPDATE quotation_sequences SET last_number = ? WHERE sequence_date = ?`,
    [nextNumber, sequenceDate]
  );
  return `QUO-${sequenceDate.replace(/-/g, '')}-${String(nextNumber).padStart(4, '0')}`;
}

router.post('/', async (req, res) => {
  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();
    const supervisor = await verifySupervisor(connection, req.body?.approval);
    const rawItems = Array.isArray(req.body?.items) ? req.body.items : [];
    if (!rawItems.length) {
      const error = new Error('Add at least one product before creating quotation.');
      error.status = 400;
      throw error;
    }
    if (rawItems.length > 500) {
      const error = new Error('Quotation supports a maximum of 500 product lines.');
      error.status = 400;
      throw error;
    }

    const items = rawItems.map((item, index) => {
      const quantity = numberValue(item.quantity);
      const salePrice = numberValue(item.sale_price);
      const gstPercent = numberValue(item.gst_percent);
      if (!cleanText(item.product_name) || quantity <= 0 || salePrice < 0 || gstPercent < 0 || gstPercent > 100) {
        const error = new Error(`Invalid quotation product at line ${index + 1}.`);
        error.status = 400;
        throw error;
      }
      const lineTotal = quantity * salePrice;
      const taxable = lineTotal / (1 + gstPercent / 100);
      return {
        barcode: cleanText(item.barcode, 120),
        product_name: cleanText(item.product_name),
        hsn_code: cleanText(item.hsn_code, 20),
        unit_type: cleanText(item.unit_type || item.unit, 40),
        pack_measure: cleanText(item.pack_measure, 60),
        quantity,
        mrp: Math.max(numberValue(item.mrp), 0),
        sale_price: salePrice,
        gst_percent: gstPercent,
        taxable_amount: taxable,
        tax_amount: lineTotal - taxable,
        line_total: lineTotal
      };
    });

    const subTotal = items.reduce((sum, item) => sum + item.taxable_amount, 0);
    const gstTotal = items.reduce((sum, item) => sum + item.tax_amount, 0);
    const unroundedGrand = subTotal + gstTotal;
    const grandTotal = Math.round(unroundedGrand);
    const quotationNo = await nextQuotationNumber(connection);
    const validityDays = Math.min(Math.max(Math.trunc(numberValue(req.body.validity_days, 7)), 1), 365);
    const taxType = req.body.tax_type === 'INTERSTATE' ? 'INTERSTATE' : 'LOCAL';

    await connection.query(
      `INSERT INTO quotations
       (quotation_no, customer_name, customer_phone, customer_address, customer_gstin,
        billing_counter, billing_tier, tax_type, sub_total, gst_total, round_off, grand_total,
        validity_days, notes, status, created_by, approved_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ACTIVE', ?, ?)`,
      [
        quotationNo,
        cleanText(req.body.customer_name, 150) || 'Walk-in Customer',
        cleanText(req.body.customer_phone, 20),
        cleanText(req.body.customer_address, 500),
        cleanText(req.body.customer_gstin, 15),
        cleanText(req.body.billing_counter, 40),
        req.body.billing_tier === 'WHOLESALE' ? 'WHOLESALE' : 'RETAIL',
        taxType,
        subTotal.toFixed(2),
        gstTotal.toFixed(2),
        (grandTotal - unroundedGrand).toFixed(2),
        grandTotal.toFixed(2),
        validityDays,
        cleanText(req.body.notes, 1000),
        cleanText(req.user?.username, 100),
        supervisor.username
      ]
    );

    for (let index = 0; index < items.length; index += 1) {
      const item = items[index];
      await connection.query(
        `INSERT INTO quotation_items
         (quotation_no, line_no, barcode, product_name, hsn_code, unit_type, pack_measure,
          quantity, mrp, sale_price, gst_percent, taxable_amount, tax_amount, line_total)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [quotationNo, index + 1, item.barcode, item.product_name, item.hsn_code, item.unit_type,
          item.pack_measure, item.quantity, item.mrp, item.sale_price, item.gst_percent,
          item.taxable_amount.toFixed(2), item.tax_amount.toFixed(2), item.line_total.toFixed(2)]
      );
    }

    await connection.query(
      `INSERT INTO audit_logs (user_id, username, role, action, entity_type, entity_id, details)
       VALUES (?, ?, ?, 'QUOTATION_CREATED', 'QUOTATION', ?, ?)`,
      [
        req.user?.id || null,
        cleanText(req.user?.username, 100) || 'system',
        cleanText(req.user?.role, 30) || 'SYSTEM',
        quotationNo,
        JSON.stringify({ approved_by: supervisor.username, grand_total: grandTotal.toFixed(2), item_count: items.length })
      ]
    );
    await connection.commit();
    res.status(201).json({ quotation_no: quotationNo, grand_total: grandTotal.toFixed(2) });
  } catch (err) {
    await connection.rollback();
    console.error('Quotation create failed:', err.message);
    res.status(err.status || 500).json({ error: err.status ? err.message : 'Unable to create quotation.' });
  } finally {
    connection.release();
  }
});

router.get('/', async (req, res) => {
  try {
    const from = cleanText(req.query.from, 10);
    const to = cleanText(req.query.to, 10);
    const search = cleanText(req.query.search, 120);
    const params = [];
    const filters = [];
    if (from) { filters.push('DATE(q.created_at) >= ?'); params.push(from); }
    if (to) { filters.push('DATE(q.created_at) <= ?'); params.push(to); }
    if (search) {
      filters.push('(q.quotation_no LIKE ? OR q.customer_name LIKE ? OR q.customer_phone LIKE ?)');
      const like = `%${search}%`;
      params.push(like, like, like);
    }
    const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
    const [rows] = await db.query(
      `SELECT q.*, (SELECT COUNT(*) FROM quotation_items qi WHERE qi.quotation_no = q.quotation_no) AS item_count
       FROM quotations q ${where} ORDER BY q.created_at DESC, q.id DESC LIMIT 1000`,
      params
    );
    const totals = rows.reduce((summary, row) => ({
      count: summary.count + 1,
      amount: summary.amount + numberValue(row.grand_total)
    }), { count: 0, amount: 0 });
    res.json({ rows, totals });
  } catch (err) {
    console.error('Quotation list failed:', err.message);
    res.status(500).json({ error: 'Unable to load quotations.' });
  }
});

router.get('/:quotationNo', async (req, res) => {
  try {
    const quotationNo = cleanText(req.params.quotationNo, 50);
    const [[headers], [items]] = await Promise.all([
      db.query('SELECT * FROM quotations WHERE quotation_no = ? LIMIT 1', [quotationNo]),
      db.query('SELECT * FROM quotation_items WHERE quotation_no = ? ORDER BY line_no, id', [quotationNo])
    ]);
    if (!headers[0]) return res.status(404).json({ error: 'Quotation not found.' });
    res.json({ quotation: headers[0], items });
  } catch (err) {
    console.error('Quotation details failed:', err.message);
    res.status(500).json({ error: 'Unable to load quotation details.' });
  }
});

module.exports = router;