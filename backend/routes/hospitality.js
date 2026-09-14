const express = require('express');
const db = require('../config/db');
const { authenticate, authorize } = require('../middleware/auth');
const { normalizeDate, parseMoney, todayIso } = require('../utils/formatters');

const router = express.Router();

const BUSINESS_PROFILE = {
  hotel_name: 'ANVI GRAND',
  restaurant_name: 'CHIGURU',
  platform_name: 'ANVI GRAND Hospitality Platform',
  address: 'Near Benz Circle, Eluru Road, Vijayawada, Krishna Dist, Andhra Pradesh',
  phone: '7569494949'
};

const CONTENT_TYPES = new Set(['GALLERY', 'FOOD', 'ROOM', 'BANQUET']);
const BOOKING_TYPES = new Set(['ROOM', 'FOOD', 'BANQUET']);
const BOOKING_STATUS = new Set(['ENQUIRY', 'ADVANCE', 'CONFIRMED', 'CHECKED_IN', 'COMPLETED', 'CANCELLED']);
const TASK_AREAS = new Set(['RECEPTION', 'KITCHEN', 'MANAGER', 'SERVER', 'SUPPLIER', 'STORE', 'HOUSEKEEPING', 'LAUNDRY', 'ACCOUNTS']);
const TASK_STATUS = new Set(['OPEN', 'IN_PROGRESS', 'DONE', 'CANCELLED']);
const STOCK_DIRECTIONS = new Set(['INWARD', 'OUTWARD']);

let schemaReadyPromise = null;

function cleanText(value, maxLength = 255) {
  return String(value || '').trim().slice(0, maxLength);
}

function cleanPhone(value) {
  return String(value || '').replace(/[^\d+]/g, '').slice(0, 20);
}

function contentType(value) {
  const normalized = String(value || '').toUpperCase();
  return CONTENT_TYPES.has(normalized) ? normalized : 'GALLERY';
}

function bookingType(value) {
  const normalized = String(value || '').toUpperCase();
  return BOOKING_TYPES.has(normalized) ? normalized : 'ROOM';
}

function bookingStatus(value) {
  const normalized = String(value || '').toUpperCase();
  return BOOKING_STATUS.has(normalized) ? normalized : 'ENQUIRY';
}

function taskArea(value) {
  const normalized = String(value || '').toUpperCase();
  return TASK_AREAS.has(normalized) ? normalized : 'RECEPTION';
}

function taskStatus(value) {
  const normalized = String(value || '').toUpperCase();
  return TASK_STATUS.has(normalized) ? normalized : 'OPEN';
}

async function ensureSchema() {
  if (!schemaReadyPromise) {
    schemaReadyPromise = (async () => {
      await db.query(`
        CREATE TABLE IF NOT EXISTS hospitality_content (
          id BIGINT AUTO_INCREMENT PRIMARY KEY,
          content_type ENUM('GALLERY','FOOD','ROOM','BANQUET') NOT NULL,
          title VARCHAR(160) NOT NULL,
          description TEXT DEFAULT NULL,
          image_url TEXT DEFAULT NULL,
          price DECIMAL(12,2) NOT NULL DEFAULT 0.00,
          unit_label VARCHAR(80) DEFAULT '',
          capacity INT DEFAULT NULL,
          display_order INT NOT NULL DEFAULT 0,
          is_active TINYINT(1) NOT NULL DEFAULT 1,
          created_by VARCHAR(100) DEFAULT '',
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
          INDEX idx_hospitality_content_type_active (content_type, is_active, display_order, id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
      `);
      await db.query(`
        CREATE TABLE IF NOT EXISTS hospitality_bookings (
          id BIGINT AUTO_INCREMENT PRIMARY KEY,
          booking_type ENUM('ROOM','FOOD','BANQUET') NOT NULL,
          booking_date DATE NOT NULL,
          time_slot VARCHAR(80) DEFAULT '',
          customer_name VARCHAR(160) NOT NULL,
          customer_phone VARCHAR(20) NOT NULL,
          customer_address VARCHAR(500) DEFAULT '',
          item_title VARCHAR(160) DEFAULT '',
          guest_count INT DEFAULT NULL,
          total_amount DECIMAL(12,2) NOT NULL DEFAULT 0.00,
          advance_amount DECIMAL(12,2) NOT NULL DEFAULT 0.00,
          balance_amount DECIMAL(12,2) NOT NULL DEFAULT 0.00,
          payment_mode VARCHAR(40) DEFAULT 'Cash',
          status ENUM('ENQUIRY','ADVANCE','CONFIRMED','CHECKED_IN','COMPLETED','CANCELLED') NOT NULL DEFAULT 'ENQUIRY',
          notes TEXT DEFAULT NULL,
          created_by VARCHAR(100) DEFAULT '',
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
          INDEX idx_hospitality_bookings_date_type (booking_date, booking_type),
          INDEX idx_hospitality_bookings_status (status, booking_date)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
      `);
      await db.query(`
        CREATE TABLE IF NOT EXISTS hospitality_ops_tasks (
          id BIGINT AUTO_INCREMENT PRIMARY KEY,
          task_date DATE NOT NULL,
          area ENUM('RECEPTION','KITCHEN','MANAGER','SERVER','SUPPLIER','STORE','HOUSEKEEPING','LAUNDRY','ACCOUNTS') NOT NULL,
          title VARCHAR(180) NOT NULL,
          assigned_to VARCHAR(120) DEFAULT '',
          amount DECIMAL(12,2) NOT NULL DEFAULT 0.00,
          status ENUM('OPEN','IN_PROGRESS','DONE','CANCELLED') NOT NULL DEFAULT 'OPEN',
          notes TEXT DEFAULT NULL,
          created_by VARCHAR(100) DEFAULT '',
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
          INDEX idx_hospitality_tasks_date_area (task_date, area),
          INDEX idx_hospitality_tasks_status (status, task_date)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
      `);
      await db.query(`
        CREATE TABLE IF NOT EXISTS hospitality_stock_movements (
          id BIGINT AUTO_INCREMENT PRIMARY KEY,
          movement_date DATE NOT NULL,
          direction ENUM('INWARD','OUTWARD') NOT NULL,
          item_name VARCHAR(180) NOT NULL,
          supplier_name VARCHAR(160) DEFAULT '',
          quantity DECIMAL(12,3) NOT NULL DEFAULT 0.000,
          unit_label VARCHAR(40) DEFAULT '',
          amount DECIMAL(12,2) NOT NULL DEFAULT 0.00,
          purpose VARCHAR(180) DEFAULT '',
          notes TEXT DEFAULT NULL,
          created_by VARCHAR(100) DEFAULT '',
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          INDEX idx_hospitality_stock_date_direction (movement_date, direction)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
      `);

      const [[existing]] = await db.query('SELECT COUNT(*) AS count FROM hospitality_content');
      if (Number(existing.count || 0) === 0) {
        await db.query(
          `INSERT INTO hospitality_content
           (content_type, title, description, image_url, price, unit_label, capacity, display_order, created_by)
           VALUES ?`,
          [[
            ['GALLERY', 'ANVI GRAND Front View', 'Hotel, restaurant and banquet experience near Benz Circle.', '', 0, '', null, 1, 'system'],
            ['FOOD', 'CHIGURU Veg Meals', 'Fresh Andhra meals for dine-in and online food orders.', '', 180, 'plate', null, 1, 'system'],
            ['FOOD', 'CHIGURU Special Biryani', 'Signature restaurant item for quick menu setup.', '', 260, 'plate', null, 2, 'system'],
            ['ROOM', 'Deluxe Room', 'Comfortable room for family and business guests.', '', 2500, 'night', 2, 1, 'system'],
            ['BANQUET', 'Banquet Hall', 'Event hall for functions, meetings and celebrations.', '', 25000, 'event', 250, 1, 'system'],
            ['BANQUET', 'Mini Hall', 'Compact hall for birthdays and small family events.', '', 12000, 'event', 80, 2, 'system']
          ]]
        );
      }
    })();
  }
  return schemaReadyPromise;
}

router.use(async (_req, _res, next) => {
  try {
    await ensureSchema();
    next();
  } catch (err) {
    next(err);
  }
});

router.get('/public', async (_req, res) => {
  const [content] = await db.query(
    `SELECT id, content_type, title, description, image_url, price, unit_label, capacity, display_order
     FROM hospitality_content
     WHERE is_active = 1
     ORDER BY content_type, display_order, id`
  );
  res.json({ profile: BUSINESS_PROFILE, content });
});

async function saveBookingRecord(req, res, createdBy = '') {
  const id = Number.parseInt(req.body?.id, 10) || null;
  const customerName = cleanText(req.body?.customer_name, 160);
  const customerPhone = cleanPhone(req.body?.customer_phone);
  if (!customerName || !customerPhone) return res.status(400).json({ error: 'Customer name and phone are required.' });

  const total = parseMoney(req.body?.total_amount);
  const advance = parseMoney(req.body?.advance_amount);
  const payload = [
    bookingType(req.body?.booking_type),
    normalizeDate(req.body?.booking_date, todayIso()),
    cleanText(req.body?.time_slot, 80),
    customerName,
    customerPhone,
    cleanText(req.body?.customer_address, 500),
    cleanText(req.body?.item_title, 160),
    Number.parseInt(req.body?.guest_count, 10) || null,
    total,
    advance,
    Math.max(total - advance, 0),
    cleanText(req.body?.payment_mode, 40) || 'Cash',
    bookingStatus(req.body?.status),
    cleanText(req.body?.notes, 2000)
  ];

  if (id) {
    await db.query(
      `UPDATE hospitality_bookings
       SET booking_type = ?, booking_date = ?, time_slot = ?, customer_name = ?, customer_phone = ?,
           customer_address = ?, item_title = ?, guest_count = ?, total_amount = ?, advance_amount = ?,
           balance_amount = ?, payment_mode = ?, status = ?, notes = ?
       WHERE id = ?`,
      [...payload, id]
    );
    return res.json({ success: true, id });
  }

  const [result] = await db.query(
    `INSERT INTO hospitality_bookings
     (booking_type, booking_date, time_slot, customer_name, customer_phone, customer_address, item_title,
      guest_count, total_amount, advance_amount, balance_amount, payment_mode, status, notes, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [...payload, createdBy]
  );
  res.json({ success: true, id: result.insertId });
}

router.post('/public/bookings', async (req, res) => {
  req.body = { ...(req.body || {}), status: 'ENQUIRY' };
  return saveBookingRecord(req, res, 'website');
});

router.use(authenticate, authorize('SERVER', 'ADMIN'));

router.get('/summary', async (_req, res) => {
  const [[bookings]] = await db.query(
    `SELECT
       COUNT(*) AS total_bookings,
       SUM(CASE WHEN booking_date = CURDATE() THEN 1 ELSE 0 END) AS today_bookings,
       COALESCE(SUM(advance_amount), 0) AS advance_total,
       COALESCE(SUM(balance_amount), 0) AS balance_total
     FROM hospitality_bookings
     WHERE status <> 'CANCELLED'`
  );
  const [[tasks]] = await db.query(
    `SELECT
       SUM(CASE WHEN status IN ('OPEN','IN_PROGRESS') THEN 1 ELSE 0 END) AS pending_tasks,
       SUM(CASE WHEN task_date = CURDATE() AND status <> 'CANCELLED' THEN 1 ELSE 0 END) AS today_tasks
     FROM hospitality_ops_tasks`
  );
  const [[stock]] = await db.query(
    `SELECT
       COALESCE(SUM(CASE WHEN direction = 'INWARD' THEN amount ELSE 0 END), 0) AS inward_amount,
       COALESCE(SUM(CASE WHEN direction = 'OUTWARD' THEN amount ELSE 0 END), 0) AS outward_amount
     FROM hospitality_stock_movements
     WHERE movement_date = CURDATE()`
  );
  res.json({ profile: BUSINESS_PROFILE, bookings, tasks, stock });
});

router.get('/content', async (req, res) => {
  const type = contentType(req.query.type || 'GALLERY');
  const [rows] = await db.query(
    `SELECT id, content_type, title, description, image_url, price, unit_label, capacity, display_order, is_active
     FROM hospitality_content
     WHERE content_type = ?
     ORDER BY is_active DESC, display_order, id DESC
     LIMIT 500`,
    [type]
  );
  res.json({ rows });
});

router.post('/content', async (req, res) => {
  const id = Number.parseInt(req.body?.id, 10) || null;
  const title = cleanText(req.body?.title, 160);
  if (!title) return res.status(400).json({ error: 'Title is required.' });

  const payload = [
    contentType(req.body?.content_type),
    title,
    cleanText(req.body?.description, 2000),
    cleanText(req.body?.image_url, 3000),
    parseMoney(req.body?.price),
    cleanText(req.body?.unit_label, 80),
    Number.parseInt(req.body?.capacity, 10) || null,
    Number.parseInt(req.body?.display_order, 10) || 0,
    req.body?.is_active === false || req.body?.is_active === 0 || req.body?.is_active === '0' ? 0 : 1
  ];

  if (id) {
    await db.query(
      `UPDATE hospitality_content
       SET content_type = ?, title = ?, description = ?, image_url = ?, price = ?, unit_label = ?,
           capacity = ?, display_order = ?, is_active = ?
       WHERE id = ?`,
      [...payload, id]
    );
    return res.json({ success: true, id });
  }

  const [result] = await db.query(
    `INSERT INTO hospitality_content
     (content_type, title, description, image_url, price, unit_label, capacity, display_order, is_active, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [...payload, req.user.username]
  );
  res.json({ success: true, id: result.insertId });
});

router.delete('/content/:id', async (req, res) => {
  await db.query('DELETE FROM hospitality_content WHERE id = ?', [Number.parseInt(req.params.id, 10) || 0]);
  res.json({ success: true });
});

router.get('/bookings', async (req, res) => {
  const from = normalizeDate(req.query.from, todayIso());
  const to = normalizeDate(req.query.to, from);
  const type = String(req.query.type || 'ALL').toUpperCase();
  const params = [from <= to ? from : to, from <= to ? to : from];
  const where = ['booking_date BETWEEN ? AND ?'];
  if (BOOKING_TYPES.has(type)) {
    where.push('booking_type = ?');
    params.push(type);
  }
  const [rows] = await db.query(
    `SELECT id, booking_type, DATE_FORMAT(booking_date, '%Y-%m-%d') AS booking_date, time_slot,
            customer_name, customer_phone, customer_address, item_title, guest_count, total_amount,
            advance_amount, balance_amount, payment_mode, status, notes
     FROM hospitality_bookings
     WHERE ${where.join(' AND ')}
     ORDER BY booking_date DESC, id DESC
     LIMIT 500`,
    params
  );
  res.json({ rows });
});

router.post('/bookings', async (req, res) => saveBookingRecord(req, res, req.user.username));

router.get('/tasks', async (req, res) => {
  const from = normalizeDate(req.query.from, todayIso());
  const to = normalizeDate(req.query.to, from);
  const [rows] = await db.query(
    `SELECT id, DATE_FORMAT(task_date, '%Y-%m-%d') AS task_date, area, title, assigned_to, amount, status, notes
     FROM hospitality_ops_tasks
     WHERE task_date BETWEEN ? AND ?
     ORDER BY task_date DESC, status, id DESC
     LIMIT 500`,
    [from <= to ? from : to, from <= to ? to : from]
  );
  res.json({ rows });
});

router.post('/tasks', async (req, res) => {
  const title = cleanText(req.body?.title, 180);
  if (!title) return res.status(400).json({ error: 'Task title is required.' });
  const id = Number.parseInt(req.body?.id, 10) || null;
  const payload = [
    normalizeDate(req.body?.task_date, todayIso()),
    taskArea(req.body?.area),
    title,
    cleanText(req.body?.assigned_to, 120),
    parseMoney(req.body?.amount),
    taskStatus(req.body?.status),
    cleanText(req.body?.notes, 2000)
  ];
  if (id) {
    await db.query(
      `UPDATE hospitality_ops_tasks
       SET task_date = ?, area = ?, title = ?, assigned_to = ?, amount = ?, status = ?, notes = ?
       WHERE id = ?`,
      [...payload, id]
    );
    return res.json({ success: true, id });
  }
  const [result] = await db.query(
    `INSERT INTO hospitality_ops_tasks
     (task_date, area, title, assigned_to, amount, status, notes, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [...payload, req.user.username]
  );
  res.json({ success: true, id: result.insertId });
});

router.get('/stock-movements', async (req, res) => {
  const from = normalizeDate(req.query.from, todayIso());
  const to = normalizeDate(req.query.to, from);
  const [rows] = await db.query(
    `SELECT id, DATE_FORMAT(movement_date, '%Y-%m-%d') AS movement_date, direction, item_name,
            supplier_name, quantity, unit_label, amount, purpose, notes
     FROM hospitality_stock_movements
     WHERE movement_date BETWEEN ? AND ?
     ORDER BY movement_date DESC, id DESC
     LIMIT 500`,
    [from <= to ? from : to, from <= to ? to : from]
  );
  res.json({ rows });
});

router.post('/stock-movements', async (req, res) => {
  const itemName = cleanText(req.body?.item_name, 180);
  if (!itemName) return res.status(400).json({ error: 'Item name is required.' });
  const id = Number.parseInt(req.body?.id, 10) || null;
  const direction = STOCK_DIRECTIONS.has(String(req.body?.direction || '').toUpperCase())
    ? String(req.body.direction).toUpperCase()
    : 'INWARD';
  const payload = [
    normalizeDate(req.body?.movement_date, todayIso()),
    direction,
    itemName,
    cleanText(req.body?.supplier_name, 160),
    parseMoney(req.body?.quantity),
    cleanText(req.body?.unit_label, 40),
    parseMoney(req.body?.amount),
    cleanText(req.body?.purpose, 180),
    cleanText(req.body?.notes, 2000)
  ];
  if (id) {
    await db.query(
      `UPDATE hospitality_stock_movements
       SET movement_date = ?, direction = ?, item_name = ?, supplier_name = ?, quantity = ?,
           unit_label = ?, amount = ?, purpose = ?, notes = ?
       WHERE id = ?`,
      [...payload, id]
    );
    return res.json({ success: true, id });
  }
  const [result] = await db.query(
    `INSERT INTO hospitality_stock_movements
     (movement_date, direction, item_name, supplier_name, quantity, unit_label, amount, purpose, notes, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [...payload, req.user.username]
  );
  res.json({ success: true, id: result.insertId });
});

module.exports = router;
