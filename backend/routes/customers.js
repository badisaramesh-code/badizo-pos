const express = require('express');
const router = express.Router();
const db = require('../config/db');
const { authenticate, authorize } = require('../middleware/auth');
const { writeAuditLog } = require('../services/auditService');
const { normalizePhone } = require('../utils/formatters');

function toCustomer(row) {
  return {
    id: row.id,
    customer_name: row.customer_name,
    phone: row.phone,
    gstin: row.gstin || '',
    address: row.address || '',
    loyalty_points: Number(row.loyalty_points || 0),
    total_spent: Number(row.total_spent || 0),
    visit_count: Number(row.visit_count || 0),
    last_visit_at: row.last_visit_at,
    created_at: row.created_at
  };
}

router.use(authenticate, authorize('SERVER', 'ADMIN', 'COUNTER'));

router.get('/lookup/:phone', async (req, res) => {
  const phone = normalizePhone(req.params.phone);
  if (!phone || phone.length < 10) {
    return res.status(400).json({ error: 'Valid 10 digit phone number is required.' });
  }

  try {
    const [rows] = await db.query(
      `SELECT * FROM customers WHERE phone = ? LIMIT 1`,
      [phone]
    );
    if (!rows.length) return res.status(404).json({ error: 'Customer not found.' });
    res.json(toCustomer(rows[0]));
  } catch (err) {
    console.error('Customer lookup failed:', err.message);
    res.status(500).json({ error: 'Unable to lookup customer.' });
  }
});

router.get('/', authorize('SERVER', 'ADMIN'), async (req, res) => {
  try {
    const search = String(req.query.search || '').trim();
    const values = [];
    let whereSql = '';
    if (search) {
      whereSql = `WHERE customer_name LIKE ? OR phone LIKE ?`;
      values.push(`%${search}%`, `%${search}%`);
    }

    const [rows] = await db.query(
      `SELECT * FROM customers ${whereSql} ORDER BY updated_at DESC LIMIT 100`,
      values
    );
    res.json(rows.map(toCustomer));
  } catch (err) {
    console.error('Customer list failed:', err.message);
    res.status(500).json({ error: 'Unable to fetch customers.' });
  }
});

router.post('/', authorize('SERVER', 'ADMIN', 'COUNTER'), async (req, res) => {
  const phone = normalizePhone(req.body?.phone);
  const customerName = String(req.body?.customer_name || req.body?.name || 'Walk-in Customer').trim() || 'Walk-in Customer';
  const gstin = String(req.body?.gstin || '').trim().toUpperCase();
  const address = String(req.body?.address || '').trim();

  if (!phone || phone.length < 10) {
    return res.status(400).json({ error: 'Valid 10 digit phone number is required.' });
  }

  try {
    await db.query(
      `INSERT INTO customers (customer_name, phone, gstin, address)
       VALUES (?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         customer_name = VALUES(customer_name),
         gstin = VALUES(gstin),
         address = VALUES(address)`,
      [customerName, phone, gstin, address]
    );

    await writeAuditLog({
      user: req.user,
      action: 'CUSTOMER_SAVED',
      entityType: 'CUSTOMER',
      entityId: phone,
      details: { customerName, gstin }
    });

    const [rows] = await db.query(`SELECT * FROM customers WHERE phone = ? LIMIT 1`, [phone]);
    res.json(toCustomer(rows[0]));
  } catch (err) {
    console.error('Customer save failed:', err.message);
    res.status(500).json({ error: 'Unable to save customer.' });
  }
});

module.exports = router;
