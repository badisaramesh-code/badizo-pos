const express = require('express');
const router = express.Router();
const db = require('../config/db');
const { authenticate, authorize } = require('../middleware/auth');
const { writeAuditLog } = require('../services/auditService');
const { parseMoney, normalizePhone } = require('../utils/formatters');

function specialOrderNo() {
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
  return `SO-${stamp}`;
}

function todayIso() {
  const date = new Date();
  date.setMinutes(date.getMinutes() - date.getTimezoneOffset());
  return date.toISOString().slice(0, 10);
}

function addDaysIso(days) {
  const date = new Date();
  date.setHours(0, 0, 0, 0);
  date.setDate(date.getDate() + days);
  return date.toISOString().slice(0, 10);
}

function normalizeStatus(value) {
  const status = String(value || '').trim().toUpperCase();
  return ['DRAFT', 'CONFIRMED', 'NEED_TO_ORDER', 'ORDERED', 'READY', 'DELIVERED', 'CLOSED', 'CANCELLED'].includes(status)
    ? status
    : 'CONFIRMED';
}

function normalizePriority(value) {
  const priority = String(value || '').trim().toUpperCase();
  return ['NORMAL', 'IMPORTANT', 'URGENT'].includes(priority) ? priority : 'IMPORTANT';
}

function normalizePaymentMode(value) {
  const mode = String(value || '').trim().toUpperCase();
  if (mode === 'UPI') return 'UPI';
  if (mode === 'CARD') return 'Card';
  if (mode === 'BANK TRANSFER' || mode === 'BANK') return 'Bank Transfer';
  if (mode === 'CHEQUE' || mode === 'CHECK') return 'Cheque';
  if (mode === 'OTHER') return 'Other';
  return 'Cash';
}

function paymentStatusFor(total, paid, dueDate) {
  const balance = Math.max(total - paid, 0);
  if (balance <= 0.01) return 'PAID';
  if (paid > 0) return 'PARTIAL';
  if (dueDate) {
    const due = new Date(dueDate);
    const today = new Date();
    due.setHours(0, 0, 0, 0);
    today.setHours(0, 0, 0, 0);
    if (!Number.isNaN(due.getTime()) && due < today) return 'OVERDUE';
  }
  return paid > 0 ? 'ADVANCE' : 'DUE';
}

function normalizeItems(lines) {
  return Array.isArray(lines)
    ? lines.map((line) => {
      const quantity = parseMoney(line.quantity);
      const estimatedRate = parseMoney(line.estimated_rate);
      const lineTotal = parseMoney(line.line_total) || quantity * estimatedRate;
      const procurementType = String(line.procurement_type || '').trim().toUpperCase() === 'REGULAR_STOCK'
        ? 'REGULAR_STOCK'
        : 'SPECIAL_ORDER';
      const procurementStatus = ['NOT_ORDERED', 'ORDERED', 'RECEIVED', 'NOT_REQUIRED'].includes(String(line.procurement_status || '').trim().toUpperCase())
        ? String(line.procurement_status).trim().toUpperCase()
        : procurementType === 'REGULAR_STOCK'
          ? 'NOT_REQUIRED'
          : 'NOT_ORDERED';
      return {
        item_name: String(line.item_name || line.product_name || '').trim(),
        barcode: String(line.barcode || '').trim().toUpperCase(),
        quantity,
        unit: String(line.unit || 'Nos').trim() || 'Nos',
        estimated_rate: estimatedRate,
        line_total: lineTotal,
        procurement_type: procurementType,
        procurement_status: procurementStatus,
        supplier_name: String(line.supplier_name || '').trim(),
        notes: String(line.notes || '').trim()
      };
    }).filter((line) => line.item_name && line.quantity > 0)
    : [];
}

async function fetchOrder(connection, orderNo) {
  const [orderRows] = await connection.query(
    `SELECT * FROM special_orders WHERE order_no = ? LIMIT 1`,
    [orderNo]
  );
  if (!orderRows.length) return null;
  const [items] = await connection.query(
    `SELECT * FROM special_order_items WHERE order_no = ? ORDER BY id ASC`,
    [orderNo]
  );
  const [payments] = await connection.query(
    `SELECT * FROM special_order_payments WHERE order_no = ? ORDER BY payment_date ASC, id ASC`,
    [orderNo]
  );
  return { order: orderRows[0], items, payments };
}

router.use(authenticate, authorize('SERVER', 'ADMIN'));

router.get('/upcoming', async (_req, res) => {
  try {
    const [rows] = await db.query(
      `SELECT *
       FROM special_orders
       WHERE order_status NOT IN ('CLOSED', 'CANCELLED')
         AND required_date BETWEEN ? AND ?
       ORDER BY required_date ASC, priority DESC, id DESC
       LIMIT 100`,
      [todayIso(), addDaysIso(7)]
    );
    res.json(rows);
  } catch (err) {
    console.error('Upcoming special orders failed:', err.message);
    res.status(500).json({ error: 'Unable to load upcoming special orders.' });
  }
});

router.get('/', async (req, res) => {
  const search = String(req.query.search || '').trim();
  const status = String(req.query.status || 'OPEN').trim().toUpperCase();
  const clauses = [];
  const params = [];

  if (search) {
    clauses.push('(order_no LIKE ? OR customer_name LIKE ? OR customer_phone LIKE ? OR event_type LIKE ?)');
    params.push(`%${search}%`, `%${search}%`, `%${search}%`, `%${search}%`);
  }
  if (status === 'OPEN') {
    clauses.push("order_status NOT IN ('CLOSED', 'CANCELLED')");
  } else if (status !== 'ALL') {
    clauses.push('order_status = ?');
    params.push(normalizeStatus(status));
  }

  try {
    const [rows] = await db.query(
      `SELECT *
       FROM special_orders
       ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''}
       ORDER BY required_date ASC, id DESC
       LIMIT 300`,
      params
    );
    res.json(rows);
  } catch (err) {
    console.error('Special order list failed:', err.message);
    res.status(500).json({ error: 'Unable to load special orders.' });
  }
});

router.get('/receivables', async (req, res) => {
  const search = String(req.query.search || '').trim();
  const clauses = ["order_status NOT IN ('CLOSED', 'CANCELLED')", 'balance_due > 0.01'];
  const params = [];
  if (search) {
    clauses.push('(customer_name LIKE ? OR customer_phone LIKE ? OR order_no LIKE ?)');
    params.push(`%${search}%`, `%${search}%`, `%${search}%`);
  }

  try {
    await db.query(
      `UPDATE special_orders
       SET payment_status = 'OVERDUE'
       WHERE balance_due > 0.01
         AND due_date IS NOT NULL
         AND due_date < CURDATE()
         AND payment_status <> 'OVERDUE'`
    );
    const [rows] = await db.query(
      `SELECT *
       FROM special_orders
       WHERE ${clauses.join(' AND ')}
       ORDER BY due_date IS NULL ASC, due_date ASC, required_date ASC
       LIMIT 300`,
      params
    );
    const summary = rows.reduce((acc, row) => {
      acc.total_receivable += Number(row.balance_due || 0);
      acc.overdue_count += row.payment_status === 'OVERDUE' ? 1 : 0;
      return acc;
    }, { total_receivable: 0, overdue_count: 0, order_count: rows.length });
    res.json({ rows, summary });
  } catch (err) {
    console.error('Special order receivables failed:', err.message);
    res.status(500).json({ error: 'Unable to load customer receivables.' });
  }
});

router.get('/:orderNo', async (req, res) => {
  try {
    const details = await fetchOrder(db, String(req.params.orderNo || '').trim());
    if (!details) return res.status(404).json({ error: 'Special order not found.' });
    res.json(details);
  } catch (err) {
    console.error('Special order details failed:', err.message);
    res.status(500).json({ error: 'Unable to load special order.' });
  }
});

router.post('/', async (req, res) => {
  const customerName = String(req.body?.customer_name || '').trim();
  const customerPhone = normalizePhone(req.body?.customer_phone);
  const requiredDate = String(req.body?.required_date || '').trim();
  const items = normalizeItems(req.body?.items);
  const orderNo = String(req.body?.order_no || '').trim() || specialOrderNo();
  const orderStatus = normalizeStatus(req.body?.order_status);
  const priority = normalizePriority(req.body?.priority);
  const dueDate = req.body?.due_date || requiredDate || null;
  const advanceAmount = parseMoney(req.body?.advance_amount);

  if (!customerName) return res.status(400).json({ error: 'Customer name is required.' });
  if (!customerPhone || customerPhone.length < 10) return res.status(400).json({ error: 'Valid customer phone is required.' });
  if (!requiredDate) return res.status(400).json({ error: 'Required date is required.' });
  if (!items.length) return res.status(400).json({ error: 'Add at least one special order item.' });

  const totalAmount = items.reduce((sum, item) => sum + item.line_total, 0);
  const firstPayment = Math.min(advanceAmount, totalAmount);
  const paidAmount = firstPayment;
  const balanceDue = Math.max(totalAmount - paidAmount, 0);
  const paymentStatus = paymentStatusFor(totalAmount, paidAmount, dueDate);
  const connection = await db.getConnection();

  try {
    await connection.beginTransaction();
    await connection.query(
      `INSERT INTO customers (customer_name, phone, address)
       VALUES (?, ?, '')
       ON DUPLICATE KEY UPDATE
         customer_name = VALUES(customer_name),
         updated_at = CURRENT_TIMESTAMP`,
      [customerName, customerPhone]
    );

    await connection.query(
      `INSERT INTO special_orders
       (order_no, customer_name, customer_phone, event_type, required_date, delivery_time,
        order_status, priority, total_amount, advance_amount, paid_amount, balance_due, payment_status, due_date, notes, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         customer_name = VALUES(customer_name),
         customer_phone = VALUES(customer_phone),
         event_type = VALUES(event_type),
         required_date = VALUES(required_date),
         delivery_time = VALUES(delivery_time),
         order_status = VALUES(order_status),
         priority = VALUES(priority),
         total_amount = VALUES(total_amount),
         balance_due = GREATEST(VALUES(total_amount) - paid_amount, 0),
         payment_status = CASE
           WHEN GREATEST(VALUES(total_amount) - paid_amount, 0) <= 0.01 THEN 'PAID'
           WHEN paid_amount > 0 THEN 'PARTIAL'
           WHEN VALUES(due_date) IS NOT NULL AND VALUES(due_date) < CURDATE() THEN 'OVERDUE'
           ELSE 'DUE'
         END,
         due_date = VALUES(due_date),
         notes = VALUES(notes),
         updated_at = CURRENT_TIMESTAMP`,
      [
        orderNo,
        customerName,
        customerPhone,
        String(req.body?.event_type || '').trim(),
        requiredDate,
        String(req.body?.delivery_time || '').trim(),
        orderStatus,
        priority,
        totalAmount,
        firstPayment,
        paidAmount,
        balanceDue,
        paymentStatus,
        dueDate,
        String(req.body?.notes || '').trim().slice(0, 255),
        req.user?.username || ''
      ]
    );
    await connection.query(`DELETE FROM special_order_items WHERE order_no = ?`, [orderNo]);
    for (const item of items) {
      await connection.query(
        `INSERT INTO special_order_items
         (order_no, item_name, barcode, quantity, unit, estimated_rate, line_total,
          procurement_type, procurement_status, supplier_name, notes)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          orderNo,
          item.item_name,
          item.barcode,
          item.quantity,
          item.unit,
          item.estimated_rate,
          item.line_total,
          item.procurement_type,
          item.procurement_status,
          item.supplier_name,
          item.notes.slice(0, 255)
        ]
      );
    }
    if (firstPayment > 0 && !req.body?.order_no) {
      await connection.query(
        `INSERT INTO special_order_payments
         (order_no, payment_date, amount, payment_mode, reference_no, notes, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          orderNo,
          todayIso(),
          firstPayment,
          normalizePaymentMode(req.body?.advance_payment_mode),
          String(req.body?.advance_reference_no || '').trim(),
          'Advance at order creation',
          req.user?.username || ''
        ]
      );
    }

    await writeAuditLog({
      user: req.user,
      action: req.body?.order_no ? 'SPECIAL_ORDER_UPDATED' : 'SPECIAL_ORDER_CREATED',
      entityType: 'SPECIAL_ORDER',
      entityId: orderNo,
      details: { customerName, requiredDate, totalAmount, balanceDue },
      connection
    });
    await connection.commit();
    res.json({ success: true, order_no: orderNo, total_amount: totalAmount, paid_amount: paidAmount, balance_due: balanceDue, payment_status: paymentStatus });
  } catch (err) {
    await connection.rollback();
    console.error('Special order save failed:', err.message);
    res.status(500).json({ error: 'Unable to save special order.' });
  } finally {
    connection.release();
  }
});

router.post('/:orderNo/status', async (req, res) => {
  const orderNo = String(req.params.orderNo || '').trim();
  const status = normalizeStatus(req.body?.order_status || req.body?.status);
  try {
    const [result] = await db.query(
      `UPDATE special_orders SET order_status = ? WHERE order_no = ?`,
      [status, orderNo]
    );
    if (result.affectedRows !== 1) return res.status(404).json({ error: 'Special order not found.' });
    await writeAuditLog({ user: req.user, action: 'SPECIAL_ORDER_STATUS_UPDATED', entityType: 'SPECIAL_ORDER', entityId: orderNo, details: { status } });
    res.json({ success: true, order_no: orderNo, order_status: status });
  } catch (err) {
    console.error('Special order status failed:', err.message);
    res.status(500).json({ error: 'Unable to update special order status.' });
  }
});

router.post('/:orderNo/payments', async (req, res) => {
  const orderNo = String(req.params.orderNo || '').trim();
  const amount = parseMoney(req.body?.amount);
  const paymentDate = req.body?.payment_date || todayIso();
  if (amount <= 0) return res.status(400).json({ error: 'Payment amount must be greater than zero.' });

  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();
    const [orderRows] = await connection.query(
      `SELECT order_no, total_amount, paid_amount, due_date
       FROM special_orders
       WHERE order_no = ?
       FOR UPDATE`,
      [orderNo]
    );
    const order = orderRows[0];
    if (!order) throw new Error('Special order not found.');
    if (amount > Number(order.total_amount || 0) - Number(order.paid_amount || 0) + 0.01) {
      throw new Error('Payment cannot be more than balance due.');
    }

    const paidAmount = Number(order.paid_amount || 0) + amount;
    const balanceDue = Math.max(Number(order.total_amount || 0) - paidAmount, 0);
    const paymentStatus = paymentStatusFor(Number(order.total_amount || 0), paidAmount, order.due_date);

    const [paymentResult] = await connection.query(
      `INSERT INTO special_order_payments
       (order_no, payment_date, amount, payment_mode, reference_no, notes, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        orderNo,
        paymentDate,
        amount,
        normalizePaymentMode(req.body?.payment_mode),
        String(req.body?.reference_no || '').trim(),
        String(req.body?.notes || '').trim().slice(0, 255),
        req.user?.username || ''
      ]
    );
    await connection.query(
      `UPDATE special_orders
       SET paid_amount = ?, balance_due = ?, payment_status = ?
       WHERE order_no = ?`,
      [paidAmount, balanceDue, paymentStatus, orderNo]
    );
    await writeAuditLog({
      user: req.user,
      action: 'SPECIAL_ORDER_PAYMENT_RECORDED',
      entityType: 'SPECIAL_ORDER_PAYMENT',
      entityId: String(paymentResult.insertId),
      details: { orderNo, amount },
      connection
    });
    await connection.commit();
    res.json({ success: true, id: paymentResult.insertId, order_no: orderNo, paid_amount: paidAmount, balance_due: balanceDue, payment_status: paymentStatus });
  } catch (err) {
    await connection.rollback();
    console.error('Special order payment failed:', err.message);
    res.status(400).json({ error: err.message || 'Unable to record payment.' });
  } finally {
    connection.release();
  }
});

module.exports = router;
