const express = require('express');
const router = express.Router();
const db = require('../config/db');
const { authenticate, authorize } = require('../middleware/auth');
const { writeAuditLog } = require('../services/auditService');
const {
  allocateInvoiceNo,
  ensureSequenceRow,
  formatInvoiceNo,
  getCounterCount,
  getFinancialYear,
  normalizeCounterNo
} = require('../services/invoiceNumberService');
const { normalizePhone, parseMoney } = require('../utils/formatters');

function formatReturnNo() {
  const now = new Date();
  const stamp = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0'),
    String(now.getHours()).padStart(2, '0'),
    String(now.getMinutes()).padStart(2, '0'),
    String(now.getSeconds()).padStart(2, '0')
  ].join('');
  return `SR-${stamp}`;
}

async function awardLoyaltyPoints(connection, invoiceNo, customerName, customerPhone, grandTotal, user) {
  const phone = normalizePhone(customerPhone);
  if (!phone || phone.length < 10) return null;

  const points = Math.floor(parseMoney(grandTotal) / 100);
  await connection.query(
    `INSERT INTO customers (customer_name, phone, loyalty_points, total_spent, visit_count, last_visit_at)
     VALUES (?, ?, ?, ?, 1, CURRENT_TIMESTAMP)
     ON DUPLICATE KEY UPDATE
       customer_name = VALUES(customer_name),
       loyalty_points = loyalty_points + VALUES(loyalty_points),
       total_spent = total_spent + VALUES(total_spent),
       visit_count = visit_count + 1,
       last_visit_at = CURRENT_TIMESTAMP`,
    [customerName || 'Walk-in Customer', phone, points, parseMoney(grandTotal)]
  );

  const [rows] = await connection.query(`SELECT id FROM customers WHERE phone = ? LIMIT 1`, [phone]);
  const customerId = rows[0]?.id;
  if (customerId && points > 0) {
    await connection.query(
      `INSERT INTO loyalty_transactions (customer_id, invoice_no, points_delta, transaction_type, note)
       VALUES (?, ?, ?, 'EARN', ?)`,
      [customerId, invoiceNo, points, `Earned on invoice ${invoiceNo}`]
    );
  }

  await writeAuditLog({
    user,
    action: 'LOYALTY_POINTS_EARNED',
    entityType: 'CUSTOMER',
    entityId: phone,
    details: { invoiceNo, points, grandTotal: parseMoney(grandTotal) },
    connection
  });

  return { phone, points };
}

function requestedCounterForUser(user, requestedCounterNo) {
  if (user?.role === 'COUNTER') {
    return user.counter_no || 1;
  }
  return requestedCounterNo;
}

function enforceSavedStateCounter(user, savedState, counterNo) {
  if (user?.role !== 'COUNTER') return savedState;
  return { ...savedState, counterNo };
}

router.get('/invoice/next', authenticate, authorize('SERVER', 'ADMIN', 'COUNTER'), async (req, res) => {
  try {
    const counterCount = await getCounterCount();
    const counterNo = normalizeCounterNo(requestedCounterForUser(req.user, req.query.counter_no), counterCount);
    const financialYear = getFinancialYear();

    await ensureSequenceRow(db, financialYear, counterNo);
    const [rows] = await db.query(
      `SELECT next_number
       FROM invoice_sequences
       WHERE financial_year = ? AND counter_no = ?`,
      [financialYear, counterNo]
    );

    const sequenceNo = Number(rows[0]?.next_number || 1);
    res.json({
      invoice_no: formatInvoiceNo(financialYear, counterNo, sequenceNo),
      financial_year: financialYear,
      counter_no: counterNo,
      counter_count: counterCount,
      sequence_no: sequenceNo,
      preview: true
    });
  } catch (err) {
    console.error('Invoice preview failed:', err.message);
    res.status(500).json({ error: 'Unable to preview invoice number.' });
  }
});

router.post('/checkout', authenticate, authorize('SERVER', 'ADMIN', 'COUNTER'), async (req, res) => {
  const connection = await db.getConnection();

  try {
    const {
      counter_no,
      customer_name,
      customer_address,
      customer_phone,
      items,
      sub_total,
      gst_total,
      grand_total,
      payment_mode,
      payment_status,
      payment_reference,
      cash_received,
      change_returned,
      transaction_type,
      billing_tier,
      tax_type,
      customer_company_name,
      customer_gstin,
      total_cgst,
      total_sgst,
      total_igst,
      exchange_items,
      exchange_total
    } = req.body;

    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: 'Cart must contain at least one item.' });
    }

    await connection.beginTransaction();
    const counterCount = await getCounterCount(connection);
    const counterNo = normalizeCounterNo(requestedCounterForUser(req.user, counter_no), counterCount);
    const allocatedInvoice = await allocateInvoiceNo(connection, counterNo);
    const invoiceNo = allocatedInvoice.invoiceNo;
    const normalizedExchangeItems = Array.isArray(exchange_items)
      ? exchange_items
        .map((item) => ({
          barcode: String(item.barcode || '').trim(),
          product_name: String(item.product_name || '').trim(),
          hsn_code: String(item.hsn_code || '').trim(),
          quantity: parseMoney(item.quantity) || 0,
          sale_price: parseMoney(item.sale_price),
          gst_percent: parseMoney(item.gst_percent),
          line_total: (parseMoney(item.sale_price) * (parseMoney(item.quantity) || 0))
        }))
        .filter((item) => item.barcode && item.quantity > 0)
      : [];
    const exchangeTotal = normalizedExchangeItems.reduce((total, item) => total + item.line_total, 0) || parseMoney(exchange_total);

    await connection.query(
      `INSERT INTO invoices
       (invoice_no, customer_name, customer_address, customer_phone, sub_total, gst_total, grand_total,
        cash_received, change_returned, payment_mode, payment_status, payment_reference, billing_counter, transaction_type, billing_tier, tax_type,
        customer_company_name, customer_gstin, total_cgst, total_sgst, total_igst, exchange_total, exchange_items_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        invoiceNo,
        customer_name || 'Walk-in Customer',
        customer_address || null,
        customer_phone || '',
        parseMoney(sub_total),
        parseMoney(gst_total),
        parseMoney(grand_total),
        parseMoney(cash_received),
        parseMoney(change_returned),
        payment_mode || 'Cash',
        payment_status || 'PAID',
        payment_reference || null,
        `Counter ${counterNo}`,
        transaction_type || 'B2C',
        billing_tier || 'RETAIL',
        tax_type || 'LOCAL',
        customer_company_name || null,
        customer_gstin || null,
        parseMoney(total_cgst),
        parseMoney(total_sgst),
        parseMoney(total_igst),
        exchangeTotal,
        normalizedExchangeItems.length ? JSON.stringify(normalizedExchangeItems) : null
      ]
    );

    for (const item of items) {
      const quantity = parseMoney(item.quantity) || 1;
      const salePrice = parseMoney(item.sale_price);
      const gstPercent = parseMoney(item.gst_percent);

      if (!item.barcode || quantity <= 0) {
        throw new Error('Every bill line needs a valid barcode and quantity.');
      }

      const lineGrossTotal = salePrice * quantity;
      const taxFactor = gstPercent / (100 + gstPercent);
      const rowTaxValue = lineGrossTotal * taxFactor;
      const isInterstate = (tax_type || 'LOCAL') === 'INTERSTATE';
      const cgst = isInterstate ? 0 : rowTaxValue / 2;
      const sgst = isInterstate ? 0 : rowTaxValue / 2;
      const igst = isInterstate ? rowTaxValue : 0;

      const [stockResult] = await connection.query(
        `UPDATE products
         SET stock_qty = stock_qty - ?
         WHERE barcode = ? AND stock_qty >= ?`,
        [quantity, item.barcode, quantity]
      );

      if (stockResult.affectedRows !== 1) {
        throw new Error(`Insufficient stock or missing product for barcode ${item.barcode}.`);
      }

      await connection.query(
        `INSERT INTO invoice_items
         (invoice_no, barcode, product_name, quantity, sale_price, gst_percent, cgst_amount, sgst_amount, igst_amount)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          invoiceNo,
          item.barcode,
          item.product_name || '',
          quantity,
          salePrice,
          gstPercent,
          cgst,
          sgst,
          igst
        ]
      );
    }

    for (const item of normalizedExchangeItems) {
      const [stockResult] = await connection.query(
        `UPDATE products
         SET stock_qty = stock_qty + ?
         WHERE barcode = ?`,
        [item.quantity, item.barcode]
      );

      if (stockResult.affectedRows !== 1) {
        throw new Error(`Exchange product not found for barcode ${item.barcode}.`);
      }
    }

    await writeAuditLog({
      user: req.user,
      action: 'INVOICE_CREATED',
      entityType: 'INVOICE',
      entityId: invoiceNo,
      details: {
        counterNo,
        paymentMode: payment_mode || 'Cash',
        grandTotal: parseMoney(grand_total),
        itemCount: items.length,
        exchangeTotal,
        exchangeItemCount: normalizedExchangeItems.length
      },
      connection
    });

    await awardLoyaltyPoints(
      connection,
      invoiceNo,
      customer_name || 'Walk-in Customer',
      customer_phone || '',
      grand_total,
      req.user
    );

    await connection.commit();
    res.json({
      success: true,
      message: 'Invoice committed successfully.',
      invoice_no: invoiceNo,
      financial_year: allocatedInvoice.financialYear,
      counter_no: counterNo,
      sequence_no: allocatedInvoice.sequenceNo
    });
  } catch (err) {
    await connection.rollback();
    console.error('Checkout rollback:', err.message);
    res.status(500).json({ error: err.message });
  } finally {
    connection.release();
  }
});

router.get('/invoice/details', authenticate, authorize('SERVER', 'ADMIN', 'COUNTER'), async (req, res) => {
  const invoiceNo = String(req.query.invoice_no || '').trim();
  if (!invoiceNo) {
    return res.status(400).json({ error: 'Invoice number is required.' });
  }

  try {
    const [invoiceRows] = await db.query(
      `SELECT *
       FROM invoices
       WHERE invoice_no = ?
       LIMIT 1`,
      [invoiceNo]
    );

    if (!invoiceRows.length) {
      return res.status(404).json({ error: 'Invoice not found.' });
    }

    const [itemRows] = await db.query(
      `SELECT ii.id, ii.invoice_no, ii.barcode, ii.product_name, ii.quantity, ii.sale_price, ii.gst_percent,
              ii.cgst_amount, ii.sgst_amount, ii.igst_amount, ii.returned_qty,
              COALESCE(p.mrp, 0) AS mrp,
              COALESCE(p.hsn_code, '') AS hsn_code
       FROM invoice_items ii
       LEFT JOIN products p ON p.barcode = ii.barcode
       WHERE ii.invoice_no = ?
       ORDER BY ii.id ASC`,
      [invoiceNo]
    );

    res.json({
      invoice: invoiceRows[0],
      items: itemRows
    });
  } catch (err) {
    console.error('Invoice details failed:', err.message);
    res.status(500).json({ error: 'Unable to fetch invoice details.' });
  }
});

router.post('/invoice/reprint', authenticate, authorize('SERVER', 'ADMIN', 'COUNTER'), async (req, res) => {
  const invoiceNo = String(req.body?.invoice_no || '').trim();
  if (!invoiceNo) {
    return res.status(400).json({ error: 'Invoice number is required.' });
  }

  try {
    const [result] = await db.query(
      `UPDATE invoices
       SET reprint_count = reprint_count + 1
       WHERE invoice_no = ?`,
      [invoiceNo]
    );

    if (result.affectedRows !== 1) {
      return res.status(404).json({ error: 'Invoice not found.' });
    }

    await writeAuditLog({
      user: req.user,
      action: 'INVOICE_REPRINTED',
      entityType: 'INVOICE',
      entityId: invoiceNo
    });

    res.json({ success: true });
  } catch (err) {
    console.error('Invoice reprint audit failed:', err.message);
    res.status(500).json({ error: 'Unable to record reprint.' });
  }
});

router.post('/invoice/void', authenticate, authorize('SERVER', 'ADMIN'), async (req, res) => {
  const invoiceNo = String(req.body?.invoice_no || '').trim();
  const reason = String(req.body?.reason || '').trim();

  if (!invoiceNo || !reason) {
    return res.status(400).json({ error: 'Invoice number and cancel reason are required.' });
  }

  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();

    const [invoiceRows] = await connection.query(
      `SELECT invoice_no, invoice_status
       FROM invoices
       WHERE invoice_no = ?
       FOR UPDATE`,
      [invoiceNo]
    );

    const invoice = invoiceRows[0];
    if (!invoice) {
      await connection.rollback();
      return res.status(404).json({ error: 'Invoice not found.' });
    }

    if (invoice.invoice_status === 'CANCELLED') {
      await connection.rollback();
      return res.status(400).json({ error: 'Invoice is already cancelled.' });
    }

    if (invoice.invoice_status === 'RETURNED' || invoice.invoice_status === 'PARTIALLY_RETURNED') {
      await connection.rollback();
      return res.status(400).json({ error: 'Return has already been recorded. Use return report instead of void.' });
    }

    const [items] = await connection.query(
      `SELECT barcode, quantity
       FROM invoice_items
       WHERE invoice_no = ?`,
      [invoiceNo]
    );

    for (const item of items) {
      await connection.query(
        `UPDATE products SET stock_qty = stock_qty + ? WHERE barcode = ?`,
        [parseMoney(item.quantity), item.barcode]
      );
    }

    await connection.query(
      `UPDATE invoices
       SET invoice_status = 'CANCELLED',
           cancel_reason = ?,
           cancelled_by = ?,
           cancelled_at = CURRENT_TIMESTAMP
       WHERE invoice_no = ?`,
      [reason, req.user.username, invoiceNo]
    );

    await writeAuditLog({
      user: req.user,
      action: 'INVOICE_CANCELLED',
      entityType: 'INVOICE',
      entityId: invoiceNo,
      details: { reason, restoredLines: items.length },
      connection
    });

    await connection.commit();
    res.json({ success: true });
  } catch (err) {
    await connection.rollback();
    console.error('Invoice void failed:', err.message);
    res.status(500).json({ error: 'Unable to cancel invoice.' });
  } finally {
    connection.release();
  }
});

router.post('/return', authenticate, authorize('SERVER', 'ADMIN'), async (req, res) => {
  const invoiceNo = String(req.body?.invoice_no || '').trim();
  const reason = String(req.body?.reason || '').trim();
  const refundMode = ['Cash', 'UPI', 'Card', 'Store Credit'].includes(req.body?.refund_mode) ? req.body.refund_mode : 'Cash';
  const requestedItems = Array.isArray(req.body?.items) ? req.body.items : [];

  if (!invoiceNo || !reason || requestedItems.length === 0) {
    return res.status(400).json({ error: 'Invoice number, return reason, and return items are required.' });
  }

  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();

    const [invoiceRows] = await connection.query(
      `SELECT invoice_no, invoice_status
       FROM invoices
       WHERE invoice_no = ?
       FOR UPDATE`,
      [invoiceNo]
    );
    const invoice = invoiceRows[0];

    if (!invoice) {
      await connection.rollback();
      return res.status(404).json({ error: 'Invoice not found.' });
    }

    if (invoice.invoice_status === 'CANCELLED' || invoice.invoice_status === 'RETURNED') {
      await connection.rollback();
      return res.status(400).json({ error: `Invoice is ${invoice.invoice_status.toLowerCase()} and cannot be returned.` });
    }

    const returnNo = formatReturnNo();
    let taxableTotal = 0;
    let gstTotal = 0;
    let refundTotal = 0;

    await connection.query(
      `INSERT INTO sales_returns
       (return_no, invoice_no, reason, refund_mode, taxable_total, gst_total, refund_total, created_by)
       VALUES (?, ?, ?, ?, 0, 0, 0, ?)`,
      [returnNo, invoiceNo, reason, refundMode, req.user.username]
    );

    for (const requested of requestedItems) {
      const invoiceItemId = Number.parseInt(requested.invoice_item_id, 10);
      const returnQty = parseMoney(requested.quantity);

      if (!invoiceItemId || returnQty <= 0) continue;

      const [itemRows] = await connection.query(
        `SELECT id, barcode, product_name, quantity, sale_price, gst_percent, returned_qty
         FROM invoice_items
         WHERE id = ? AND invoice_no = ?
         FOR UPDATE`,
        [invoiceItemId, invoiceNo]
      );
      const item = itemRows[0];

      if (!item) {
        throw new Error(`Invoice item ${invoiceItemId} not found.`);
      }

      const availableQty = parseMoney(item.quantity) - parseMoney(item.returned_qty);
      if (returnQty > availableQty) {
        throw new Error(`Return quantity for ${item.product_name} cannot exceed ${availableQty}.`);
      }

      const gross = parseMoney(item.sale_price) * returnQty;
      const gstPercent = parseMoney(item.gst_percent);
      const taxable = gross / (1 + gstPercent / 100);
      const gst = gross - taxable;

      taxableTotal += taxable;
      gstTotal += gst;
      refundTotal += gross;

      await connection.query(
        `INSERT INTO sales_return_items
         (return_no, invoice_item_id, barcode, product_name, quantity, sale_price, gst_percent,
          taxable_amount, gst_amount, refund_amount)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          returnNo,
          invoiceItemId,
          item.barcode,
          item.product_name,
          returnQty,
          item.sale_price,
          item.gst_percent,
          taxable,
          gst,
          gross
        ]
      );

      await connection.query(
        `UPDATE invoice_items
         SET returned_qty = returned_qty + ?
         WHERE id = ?`,
        [returnQty, invoiceItemId]
      );

      await connection.query(
        `UPDATE products
         SET stock_qty = stock_qty + ?
         WHERE barcode = ?`,
        [returnQty, item.barcode]
      );
    }

    if (refundTotal <= 0) {
      throw new Error('No valid return quantity was entered.');
    }

    await connection.query(
      `UPDATE sales_returns
       SET taxable_total = ?, gst_total = ?, refund_total = ?
       WHERE return_no = ?`,
      [taxableTotal, gstTotal, refundTotal, returnNo]
    );

    const [remainingRows] = await connection.query(
      `SELECT COUNT(*) AS remaining
       FROM invoice_items
       WHERE invoice_no = ? AND returned_qty < quantity`,
      [invoiceNo]
    );
    const nextStatus = Number(remainingRows[0]?.remaining || 0) === 0 ? 'RETURNED' : 'PARTIALLY_RETURNED';

    await connection.query(
      `UPDATE invoices
       SET invoice_status = ?
       WHERE invoice_no = ?`,
      [nextStatus, invoiceNo]
    );

    await writeAuditLog({
      user: req.user,
      action: 'SALES_RETURN_CREATED',
      entityType: 'SALES_RETURN',
      entityId: returnNo,
      details: { invoiceNo, reason, refundMode, refundTotal },
      connection
    });

    await connection.commit();
    res.json({
      success: true,
      return_no: returnNo,
      invoice_status: nextStatus,
      taxable_total: taxableTotal,
      gst_total: gstTotal,
      refund_total: refundTotal
    });
  } catch (err) {
    await connection.rollback();
    console.error('Sales return failed:', err.message);
    res.status(500).json({ error: err.message || 'Unable to save sales return.' });
  } finally {
    connection.release();
  }
});

router.get('/hold/list', authenticate, authorize('SERVER', 'ADMIN', 'COUNTER'), async (req, res) => {
  try {
    const [rows] = await db.query(
      `SELECT invoice_no, customer_name, customer_phone, grand_total, cash_received, change_returned, billing_counter,
              payment_status, payment_reference,
              payment_mode, transaction_type, billing_tier, tax_type, invoice_status, reprint_count, created_at
       FROM invoices
       ORDER BY created_at DESC
       LIMIT 25`
    );
    res.json(rows);
  } catch (err) {
    console.error('Invoice history fetch failed:', err.message);
    res.status(500).json({ error: 'Unable to fetch invoice history.' });
  }
});

router.post('/hold', authenticate, authorize('SERVER', 'ADMIN', 'COUNTER'), async (req, res) => {
  const {
    hold_token,
    saved_state,
    counter_no,
    customer_name,
    customer_phone,
    bill_total,
    item_count,
    overwrite
  } = req.body;

  if (!hold_token || !saved_state) {
    return res.status(400).json({ error: 'Hold token and saved state are required.' });
  }

  try {
    const counterCount = await getCounterCount();
    const counterNo = normalizeCounterNo(requestedCounterForUser(req.user, counter_no || saved_state.counterNo), counterCount);
    const finalSavedState = enforceSavedStateCounter(req.user, saved_state, counterNo);
    const holdToken = hold_token.trim();
    const [existingRows] = await db.query(
      `SELECT hold_token FROM held_bills WHERE hold_token = ? LIMIT 1`,
      [holdToken]
    );

    if (existingRows.length > 0 && !overwrite) {
      return res.status(409).json({ error: 'A held bill with this token already exists.' });
    }

    await db.query(
      `INSERT INTO held_bills
       (hold_token, counter_no, customer_name, customer_phone, bill_total, item_count, saved_state)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         counter_no = VALUES(counter_no),
         customer_name = VALUES(customer_name),
         customer_phone = VALUES(customer_phone),
         bill_total = VALUES(bill_total),
         item_count = VALUES(item_count),
         saved_state = VALUES(saved_state),
         updated_at = CURRENT_TIMESTAMP`,
      [
        holdToken,
        counterNo,
        customer_name || finalSavedState.customerName || 'Walk-in Customer',
        customer_phone || finalSavedState.customerPhone || '',
        parseMoney(bill_total),
        Number.parseInt(item_count, 10) || (Array.isArray(finalSavedState.cart) ? finalSavedState.cart.length : 0),
        JSON.stringify(finalSavedState)
      ]
    );
    res.json({ success: true });
  } catch (err) {
    console.error('Hold save failed:', err.message);
    res.status(500).json({ error: 'Unable to hold bill.' });
  }
});

router.get('/holds', authenticate, authorize('SERVER', 'ADMIN', 'COUNTER'), async (req, res) => {
  try {
    const counterNo = req.user.role === 'COUNTER'
      ? Number(req.user.counter_no || 1)
      : (req.query.counter_no ? Number.parseInt(req.query.counter_no, 10) : null);
    const values = [];
    let whereSql = '';

    if (counterNo) {
      whereSql = 'WHERE counter_no = ?';
      values.push(counterNo);
    }

    const [rows] = await db.query(
      `SELECT hold_token, counter_no, customer_name, customer_phone, bill_total, item_count, saved_state, created_at, updated_at
       FROM held_bills
       ${whereSql}
       ORDER BY updated_at DESC`,
      values
    );
    res.json(rows);
  } catch (err) {
    console.error('Hold list fetch failed:', err.message);
    res.status(500).json({ error: 'Unable to fetch held bills.' });
  }
});

router.delete('/hold/:token', authenticate, authorize('SERVER', 'ADMIN', 'COUNTER'), async (req, res) => {
  try {
    await db.query(`DELETE FROM held_bills WHERE hold_token = ?`, [req.params.token]);
    res.json({ success: true });
  } catch (err) {
    console.error('Hold delete failed:', err.message);
    res.status(500).json({ error: 'Unable to remove held bill.' });
  }
});

module.exports = router;
