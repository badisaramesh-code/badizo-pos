const express = require('express');
const db = require('../config/db');
const { authenticate, authorize } = require('../middleware/auth');
const { writeAuditLog } = require('../services/auditService');
const { normalizeDate, todayIso } = require('../utils/formatters');

const router = express.Router();

const TRANSPORT_MODES = new Set(['TRANSPORT', 'AUTO', 'TROLLEY', 'RIKSHA', 'HUMAN', 'OTHER']);
const STATUSES = new Set(['OPEN', 'VERIFIED', 'CANCELLED']);

function cleanText(value, maxLength = 255) {
  return String(value || '').trim().slice(0, maxLength);
}

function normalizePhone(value) {
  return String(value || '').replace(/[^\d+]/g, '').slice(0, 20);
}

function normalizeTime(value) {
  const text = String(value || '').trim();
  const match = text.match(/^([01]?\d|2[0-3]):([0-5]\d)(?::([0-5]\d))?$/);
  if (!match) {
    const now = new Date();
    return `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}:00`;
  }
  return `${String(Number(match[1])).padStart(2, '0')}:${match[2]}:${match[3] || '00'}`;
}

function normalizeOptionalTime(value) {
  const text = String(value || '').trim();
  if (!text) return null;
  return normalizeTime(text);
}

function normalizeMovementType(value) {
  return String(value || '').toUpperCase() === 'OUT' ? 'OUT' : 'IN';
}

function normalizeTransportMode(value) {
  const mode = String(value || '').toUpperCase();
  return TRANSPORT_MODES.has(mode) ? mode : 'OTHER';
}

function normalizeStatus(value) {
  const status = String(value || '').toUpperCase();
  return STATUSES.has(status) ? status : 'OPEN';
}

function makePassNo(date, movementType, sequence) {
  return `GP-${date.replace(/-/g, '')}-${movementType}-${String(sequence).padStart(4, '0')}`;
}

async function nextPassNo(connection, date, movementType) {
  const [rows] = await connection.query(
    `SELECT COUNT(*) AS count
     FROM gate_pass_entries
     WHERE movement_date = ? AND movement_type = ?`,
    [date, movementType]
  );
  return makePassNo(date, movementType, Number(rows[0]?.count || 0) + 1);
}

function publicEntry(row) {
  return {
    ...row,
    movement_date: row.movement_date,
    package_count: Number(row.package_count || 0)
  };
}

router.use(authenticate, authorize('SERVER', 'ADMIN', 'SECURITY'));

router.get('/', async (req, res) => {
  const from = normalizeDate(req.query.from || req.query.date, todayIso());
  const to = normalizeDate(req.query.to || from, from);
  const movementType = String(req.query.movement_type || '').toUpperCase();
  const status = String(req.query.status || '').toUpperCase();
  const search = cleanText(req.query.search, 120);

  const where = ['movement_date BETWEEN ? AND ?'];
  const params = [from <= to ? from : to, from <= to ? to : from];

  if (['IN', 'OUT'].includes(movementType)) {
    where.push('movement_type = ?');
    params.push(movementType);
  }
  if (STATUSES.has(status)) {
    where.push('status = ?');
    params.push(status);
  }
  if (search) {
    where.push(`(
      pass_no LIKE ?
      OR party_name LIKE ?
      OR party_phone LIKE ?
      OR vehicle_no LIKE ?
      OR driver_phone LIKE ?
      OR document_no LIKE ?
      OR item_summary LIKE ?
    )`);
    const like = `%${search}%`;
    params.push(like, like, like, like, like, like, like);
  }

  try {
    const [rows] = await db.query(
      `SELECT id, pass_no, movement_type, DATE_FORMAT(movement_date, '%Y-%m-%d') AS movement_date,
              TIME_FORMAT(movement_time, '%H:%i') AS movement_time,
              TIME_FORMAT(movement_time, '%h:%i %p') AS movement_time_display,
              TIME_FORMAT(unload_start_time, '%H:%i') AS unload_start_time,
              TIME_FORMAT(unload_start_time, '%h:%i %p') AS unload_start_time_display,
              TIME_FORMAT(unload_end_time, '%H:%i') AS unload_end_time,
              TIME_FORMAT(unload_end_time, '%h:%i %p') AS unload_end_time_display,
              TIME_FORMAT(loading_start_time, '%H:%i') AS loading_start_time,
              TIME_FORMAT(loading_start_time, '%h:%i %p') AS loading_start_time_display,
              TIME_FORMAT(loading_end_time, '%H:%i') AS loading_end_time,
              TIME_FORMAT(loading_end_time, '%h:%i %p') AS loading_end_time_display,
              transport_mode,
              source_location, destination_location, party_name, party_phone, vehicle_no,
              driver_name, driver_phone, supervisor_name, supervisor_phone,
              security_person_name, security_person_phone, document_no, item_summary,
              package_count, remarks, status, created_by, updated_by,
              DATE_FORMAT(created_at, '%Y-%m-%d') AS added_date,
              TIME_FORMAT(created_at, '%H:%i') AS added_time,
              DATE_FORMAT(updated_at, '%Y-%m-%d') AS edited_date,
              TIME_FORMAT(updated_at, '%H:%i') AS edited_time,
              created_at, updated_at
       FROM gate_pass_entries
       WHERE ${where.join(' AND ')}
       ORDER BY movement_date DESC, movement_time DESC, id DESC
       LIMIT 500`,
      params
    );
    res.json({ from, to, rows: rows.map(publicEntry) });
  } catch (err) {
    console.error('Gate pass list failed:', err.message);
    res.status(500).json({ error: 'Unable to load gate pass entries.' });
  }
});

router.post('/', async (req, res) => {
  const id = req.body?.id ? Number.parseInt(req.body.id, 10) : null;
  const movementType = normalizeMovementType(req.body?.movement_type);
  const movementDate = normalizeDate(req.body?.movement_date || req.body?.date, todayIso());
  const movementTime = normalizeTime(req.body?.movement_time);
  const unloadStartTime = movementType === 'IN' ? normalizeOptionalTime(req.body?.unload_start_time) : null;
  const unloadEndTime = movementType === 'IN' ? normalizeOptionalTime(req.body?.unload_end_time) : null;
  const loadingStartTime = movementType === 'OUT' ? normalizeOptionalTime(req.body?.loading_start_time) : null;
  const loadingEndTime = movementType === 'OUT' ? normalizeOptionalTime(req.body?.loading_end_time) : null;
  const transportMode = normalizeTransportMode(req.body?.transport_mode);
  const status = normalizeStatus(req.body?.status);

  const payload = {
    source_location: cleanText(req.body?.source_location, 180),
    destination_location: cleanText(req.body?.destination_location, 180),
    party_name: cleanText(req.body?.party_name, 180),
    party_phone: normalizePhone(req.body?.party_phone),
    vehicle_no: cleanText(req.body?.vehicle_no, 60).toUpperCase(),
    driver_name: cleanText(req.body?.driver_name, 120),
    driver_phone: normalizePhone(req.body?.driver_phone),
    supervisor_name: cleanText(req.body?.supervisor_name, 120),
    supervisor_phone: normalizePhone(req.body?.supervisor_phone),
    security_person_name: cleanText(req.body?.security_person_name, 120),
    security_person_phone: normalizePhone(req.body?.security_person_phone),
    document_no: cleanText(req.body?.document_no, 120),
    item_summary: cleanText(req.body?.item_summary, 255),
    package_count: Math.max(Number.parseInt(req.body?.package_count, 10) || 0, 0),
    remarks: cleanText(req.body?.remarks, 255)
  };

  if (!payload.party_name) {
    return res.status(400).json({ error: 'Customer/supplier/party name is required.' });
  }
  if (!payload.security_person_name) {
    return res.status(400).json({ error: 'On duty security person name is required.' });
  }
  if (!payload.supervisor_name) {
    return res.status(400).json({ error: 'On duty supervisor name is required.' });
  }

  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();

    let passNo = cleanText(req.body?.pass_no, 80);
    if (!id || !passNo) {
      passNo = await nextPassNo(connection, movementDate, movementType);
    }

    if (id) {
      await connection.query(
        `UPDATE gate_pass_entries
         SET movement_type = ?, movement_date = ?, movement_time = ?,
             unload_start_time = ?, unload_end_time = ?, loading_start_time = ?, loading_end_time = ?,
             transport_mode = ?,
             source_location = ?, destination_location = ?, party_name = ?, party_phone = ?,
             vehicle_no = ?, driver_name = ?, driver_phone = ?, supervisor_name = ?, supervisor_phone = ?,
             security_person_name = ?, security_person_phone = ?, document_no = ?, item_summary = ?,
             package_count = ?, remarks = ?, status = ?, updated_by = ?
         WHERE id = ?`,
        [
          movementType, movementDate, movementTime,
          unloadStartTime, unloadEndTime, loadingStartTime, loadingEndTime,
          transportMode,
          payload.source_location, payload.destination_location, payload.party_name, payload.party_phone,
          payload.vehicle_no, payload.driver_name, payload.driver_phone, payload.supervisor_name, payload.supervisor_phone,
          payload.security_person_name, payload.security_person_phone, payload.document_no, payload.item_summary,
          payload.package_count, payload.remarks, status, req.user.username, id
        ]
      );
    } else {
      await connection.query(
        `INSERT INTO gate_pass_entries
         (pass_no, movement_type, movement_date, movement_time,
          unload_start_time, unload_end_time, loading_start_time, loading_end_time, transport_mode,
          source_location, destination_location, party_name, party_phone, vehicle_no,
          driver_name, driver_phone, supervisor_name, supervisor_phone,
          security_person_name, security_person_phone, document_no, item_summary,
          package_count, remarks, status, created_by, updated_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          passNo, movementType, movementDate, movementTime,
          unloadStartTime, unloadEndTime, loadingStartTime, loadingEndTime, transportMode,
          payload.source_location, payload.destination_location, payload.party_name, payload.party_phone,
          payload.vehicle_no, payload.driver_name, payload.driver_phone, payload.supervisor_name, payload.supervisor_phone,
          payload.security_person_name, payload.security_person_phone, payload.document_no, payload.item_summary,
          payload.package_count, payload.remarks, status, req.user.username, req.user.username
        ]
      );
    }

    await connection.commit();

    await writeAuditLog({
      user: req.user,
      action: id ? 'GATE_PASS_UPDATED' : 'GATE_PASS_CREATED',
      entityType: 'GATE_PASS',
      entityId: passNo,
      details: { movementType, movementDate, status, partyName: payload.party_name }
    });

    const [rows] = await db.query(
      `SELECT id, pass_no, movement_type, DATE_FORMAT(movement_date, '%Y-%m-%d') AS movement_date,
              TIME_FORMAT(movement_time, '%H:%i') AS movement_time,
              TIME_FORMAT(movement_time, '%h:%i %p') AS movement_time_display,
              TIME_FORMAT(unload_start_time, '%H:%i') AS unload_start_time,
              TIME_FORMAT(unload_start_time, '%h:%i %p') AS unload_start_time_display,
              TIME_FORMAT(unload_end_time, '%H:%i') AS unload_end_time,
              TIME_FORMAT(unload_end_time, '%h:%i %p') AS unload_end_time_display,
              TIME_FORMAT(loading_start_time, '%H:%i') AS loading_start_time,
              TIME_FORMAT(loading_start_time, '%h:%i %p') AS loading_start_time_display,
              TIME_FORMAT(loading_end_time, '%H:%i') AS loading_end_time,
              TIME_FORMAT(loading_end_time, '%h:%i %p') AS loading_end_time_display,
              transport_mode,
              source_location, destination_location, party_name, party_phone, vehicle_no,
              driver_name, driver_phone, supervisor_name, supervisor_phone,
              security_person_name, security_person_phone, document_no, item_summary,
              package_count, remarks, status, created_by, updated_by,
              DATE_FORMAT(created_at, '%Y-%m-%d') AS added_date,
              TIME_FORMAT(created_at, '%H:%i') AS added_time,
              DATE_FORMAT(updated_at, '%Y-%m-%d') AS edited_date,
              TIME_FORMAT(updated_at, '%H:%i') AS edited_time,
              created_at, updated_at
       FROM gate_pass_entries
       WHERE pass_no = ?
       LIMIT 1`,
      [passNo]
    );
    res.json(publicEntry(rows[0]));
  } catch (err) {
    await connection.rollback();
    console.error('Gate pass save failed:', err.message);
    res.status(500).json({ error: 'Unable to save gate pass entry.' });
  } finally {
    connection.release();
  }
});

module.exports = router;
