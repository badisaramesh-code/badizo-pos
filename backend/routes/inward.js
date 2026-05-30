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
    String(now.getSeconds()).padStart(2, '0')
  ].join('');
  return `INW-${stamp}`;
}

router.use(authenticate, authorize('SERVER', 'ADMIN'));

router.get('/recent', async (_req, res) => {
  try {
    const [rows] = await db.query(
      `SELECT inward_no, supplier_name, supplier_invoice_no, supplier_invoice_date,
              item_count, total_qty, grand_total, created_by, created_at
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

router.post('/', async (req, res) => {
  const { supplier = {}, lines = [] } = req.body || {};

  if (!supplier.name || !String(supplier.name).trim()) {
    return res.status(400).json({ error: 'Supplier name is required.' });
  }

  const validLines = Array.isArray(lines)
    ? lines
      .map((line) => ({
        product_name: String(line.product || line.product_name || '').trim(),
        barcode: String(line.barcode || '').trim().toUpperCase(),
        hsn_code: String(line.hsn_code || '').trim(),
        gst_percent: parseMoney(line.gst_percent),
        purchase_price: parseMoney(line.price || line.purchase_price),
        discount_percent: parseMoney(line.discount),
        scheme: String(line.scheme || '').trim(),
        quantity: parseMoney(line.qty || line.quantity)
      }))
      .filter((line) => line.product_name || line.barcode || line.quantity)
    : [];

  if (validLines.length === 0) {
    return res.status(400).json({ error: 'At least one inward product line is required.' });
  }

  const invalidLine = validLines.find((line) => !line.product_name || !line.barcode || line.quantity <= 0 || line.purchase_price < 0);
  if (invalidLine) {
    return res.status(400).json({ error: 'Every inward line needs product, barcode, quantity, and valid price.' });
  }

  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();
    const finalInwardNo = inwardNo();

    let totalQty = 0;
    let taxableTotal = 0;
    let gstTotal = 0;
    let grandTotal = 0;

    await connection.query(
      `INSERT INTO inward_entries
       (inward_no, supplier_name, supplier_address, supplier_gstin, supplier_phone,
        supplier_invoice_no, supplier_invoice_date, item_count, total_qty, taxable_total,
        gst_total, grand_total, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, 0, 0, 0, ?)`,
      [
        finalInwardNo,
        String(supplier.name || '').trim(),
        String(supplier.address || '').trim(),
        String(supplier.gstin || '').trim().toUpperCase(),
        String(supplier.phone || '').trim(),
        String(supplier.invoice_no || '').trim(),
        supplier.invoice_date || null,
        req.user.username
      ]
    );

    for (const line of validLines) {
      const gross = line.purchase_price * line.quantity;
      const discountAmount = gross * (line.discount_percent / 100);
      const taxable = gross - discountAmount;
      const gstAmount = taxable * (line.gst_percent / 100);
      const lineTotal = taxable + gstAmount;

      totalQty += line.quantity;
      taxableTotal += taxable;
      gstTotal += gstAmount;
      grandTotal += lineTotal;

      await connection.query(
        `INSERT INTO inward_items
         (inward_no, barcode, product_name, hsn_code, gst_percent, purchase_price, discount_percent,
          scheme, quantity, taxable_amount, gst_amount, total_amount)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          finalInwardNo,
          line.barcode,
          line.product_name,
          line.hsn_code,
          line.gst_percent,
          line.purchase_price,
          line.discount_percent,
          line.scheme,
          line.quantity,
          taxable,
          gstAmount,
          lineTotal
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
               gst_percent = ?
           WHERE barcode = ?`,
          [line.quantity, line.product_name, line.hsn_code, line.gst_percent, line.barcode]
        );
      } else {
        await connection.query(
          `INSERT INTO products
           (product_code, barcode, product_name, hsn_code, gst_percent, mrp, sale_price, wholesale_price, stock_qty)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            `BDZ${Date.now().toString().slice(-8)}`,
            line.barcode,
            line.product_name,
            line.hsn_code,
            line.gst_percent,
            line.purchase_price,
            line.purchase_price,
            line.purchase_price,
            line.quantity
          ]
        );
      }
    }

    await connection.query(
      `UPDATE inward_entries
       SET item_count = ?, total_qty = ?, taxable_total = ?, gst_total = ?, grand_total = ?
       WHERE inward_no = ?`,
      [validLines.length, totalQty, taxableTotal, gstTotal, grandTotal, finalInwardNo]
    );

    await writeAuditLog({
      user: req.user,
      action: 'INWARD_CREATED',
      entityType: 'INWARD',
      entityId: finalInwardNo,
      details: {
        supplier: supplier.name,
        itemCount: validLines.length,
        totalQty,
        grandTotal
      },
      connection
    });

    await connection.commit();
    res.json({
      success: true,
      inward_no: finalInwardNo,
      item_count: validLines.length,
      total_qty: totalQty,
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
