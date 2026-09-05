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
    gstin: row.resolved_gstin || row.gstin || '',
    address: row.resolved_address || row.address || '',
    loyalty_points: Number(row.loyalty_points || 0),
    total_spent: Number(row.total_spent || 0),
    visit_count: Number(row.visit_count || 0),
    billing_count: Number(row.billing_count || row.visit_count || 0),
    last_invoice_at: row.last_invoice_at || null,
    last_visit_at: row.last_visit_at,
    created_at: row.created_at
  };
}

router.use(authenticate, authorize('SERVER', 'ADMIN', 'COUNTER'));

router.get('/match', async (req, res) => {
  const phone = normalizePhone(req.query.phone);
  const customerName = String(req.query.name || '').trim();

  if ((!phone || phone.length < 10) && customerName.length < 3) {
    return res.status(400).json({ error: 'Full customer name or valid 10 digit phone number is required.' });
  }

  const matchByPhone = Boolean(phone && phone.length >= 10);
  const matchSql = matchByPhone
    ? 'i.customer_phone = ?'
    : 'LOWER(TRIM(i.customer_name)) = LOWER(?)';
  const matchValue = matchByPhone ? phone : customerName;

  try {
    const [invoiceRows] = await db.query(
      `SELECT i.customer_name, i.customer_phone, i.customer_address, i.customer_gstin,
              i.invoice_no AS last_invoice_no, i.created_at AS last_invoice_at
       FROM invoices i
       WHERE i.invoice_status <> 'CANCELLED'
         AND ${matchSql}
       ORDER BY i.created_at DESC
       LIMIT 1`,
      [matchValue]
    );
    if (!invoiceRows.length) return res.status(404).json({ error: 'Customer not found in previous bills.' });

    const latest = invoiceRows[0];
    const resolvedPhone = normalizePhone(latest.customer_phone);
    const resolvedName = String(latest.customer_name || customerName).trim();
    const aggregateSql = resolvedPhone && resolvedPhone.length >= 10
      ? 'customer_phone = ?'
      : 'LOWER(TRIM(customer_name)) = LOWER(?)';
    const aggregateValue = resolvedPhone && resolvedPhone.length >= 10 ? resolvedPhone : resolvedName;

    const [[totals], [customerRows]] = await Promise.all([
      db.query(
        `SELECT COUNT(*) AS billing_count,
                COALESCE(SUM(grand_total), 0) AS total_spent,
                MAX(created_at) AS last_invoice_at
         FROM invoices
         WHERE invoice_status <> 'CANCELLED'
           AND ${aggregateSql}`,
        [aggregateValue]
      ),
      resolvedPhone && resolvedPhone.length >= 10
        ? db.query('SELECT * FROM customers WHERE phone = ? LIMIT 1', [resolvedPhone])
        : Promise.resolve([[]])
    ]);
    const customer = customerRows[0] || {};

    res.json({
      id: customer.id || null,
      customer_name: resolvedName || customer.customer_name || '',
      phone: resolvedPhone || customer.phone || '',
      gstin: latest.customer_gstin || customer.gstin || '',
      address: latest.customer_address || customer.address || '',
      loyalty_points: Number(customer.loyalty_points || 0),
      total_spent: Number(totals[0]?.total_spent || customer.total_spent || 0),
      visit_count: Number(totals[0]?.billing_count || customer.visit_count || 0),
      billing_count: Number(totals[0]?.billing_count || customer.visit_count || 0),
      last_invoice_no: latest.last_invoice_no || '',
      last_invoice_at: totals[0]?.last_invoice_at || latest.last_invoice_at || null
    });
  } catch (err) {
    console.error('Customer previous bill match failed:', err.message);
    res.status(500).json({ error: 'Unable to load customer details from previous bills.' });
  }
});
router.get('/lookup/:phone', async (req, res) => {
  const phone = normalizePhone(req.params.phone);
  if (!phone || phone.length < 10) {
    return res.status(400).json({ error: 'Valid 10 digit phone number is required.' });
  }

  try {
    const [rows] = await db.query(
      `SELECT c.*,
              COUNT(i.invoice_no) AS billing_count,
              MAX(i.created_at) AS last_invoice_at
       FROM customers c
       LEFT JOIN invoices i
         ON i.customer_phone = c.phone
        AND i.invoice_status <> 'CANCELLED'
       WHERE c.phone = ?
       GROUP BY c.id
       LIMIT 1`,
      [phone]
    );
    if (!rows.length) return res.status(404).json({ error: 'Customer not found.' });
    res.json(toCustomer(rows[0]));
  } catch (err) {
    console.error('Customer lookup failed:', err.message);
    res.status(500).json({ error: 'Unable to lookup customer.' });
  }
});

router.get('/', authorize('SERVER', 'ADMIN', 'COUNTER'), async (req, res) => {
  try {
    const search = String(req.query.search || '').trim();
    const values = [];
    let whereSql = '';
    if (search) {
      whereSql = `WHERE c.customer_name LIKE ? OR c.phone LIKE ?`;
      values.push(`%${search}%`, `%${search}%`);
    }

    const [rows] = await db.query(
      `SELECT c.*,
              COALESCE(NULLIF(c.gstin, ''), (
                SELECT i2.customer_gstin FROM invoices i2
                WHERE i2.customer_phone = c.phone
                  AND i2.invoice_status <> 'CANCELLED'
                  AND COALESCE(i2.customer_gstin, '') <> ''
                ORDER BY i2.created_at DESC LIMIT 1
              ), '') AS resolved_gstin,
              COALESCE(NULLIF(c.address, ''), (
                SELECT i3.customer_address FROM invoices i3
                WHERE i3.customer_phone = c.phone
                  AND i3.invoice_status <> 'CANCELLED'
                  AND COALESCE(i3.customer_address, '') <> ''
                ORDER BY i3.created_at DESC LIMIT 1
              ), '') AS resolved_address,
              COUNT(i.invoice_no) AS billing_count,
              MAX(i.created_at) AS last_invoice_at
       FROM customers c
       LEFT JOIN invoices i
         ON i.customer_phone = c.phone
        AND i.invoice_status <> 'CANCELLED'
       ${whereSql}
       GROUP BY c.id
       ORDER BY c.updated_at DESC
       LIMIT 100`,
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

    const [rows] = await db.query(
      `SELECT c.*,
              COUNT(i.invoice_no) AS billing_count,
              MAX(i.created_at) AS last_invoice_at
       FROM customers c
       LEFT JOIN invoices i
         ON i.customer_phone = c.phone
        AND i.invoice_status <> 'CANCELLED'
       WHERE c.phone = ?
       GROUP BY c.id
       LIMIT 1`,
      [phone]
    );
    res.json(toCustomer(rows[0]));
  } catch (err) {
    console.error('Customer save failed:', err.message);
    res.status(500).json({ error: 'Unable to save customer.' });
  }
});

module.exports = router;
