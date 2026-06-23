const express = require('express');
const db = require('../config/db');
const { authenticate, authorize } = require('../middleware/auth');
const { normalizeDate, parseMoney, todayIso } = require('../utils/formatters');

const router = express.Router();

const ATTENDANCE_STATUS = new Set(['PRESENT', 'HALF_DAY', 'ABSENT', 'PAID_LEAVE', 'WEEK_OFF']);
const SALARY_TYPES = new Set(['MONTHLY', 'DAILY', 'HOURLY']);
const PAYMENT_MODES = new Set(['Cash', 'UPI', 'Bank', 'Other']);

function cleanText(value, maxLength = 255) {
  return String(value || '').trim().slice(0, maxLength);
}

function cleanPhone(value) {
  return String(value || '').replace(/[^\d+]/g, '').slice(0, 20);
}

function cleanTime(value) {
  const text = String(value || '').trim();
  return /^([01]?\d|2[0-3]):[0-5]\d$/.test(text) ? `${text}:00` : null;
}

function cleanMonth(value) {
  const text = String(value || '').trim();
  return /^\d{4}-\d{2}$/.test(text) ? text : todayIso().slice(0, 7);
}

function monthRange(month) {
  const [year, monthNo] = cleanMonth(month).split('-').map(Number);
  const from = `${year}-${String(monthNo).padStart(2, '0')}-01`;
  const lastDay = new Date(year, monthNo, 0).getDate();
  const to = `${year}-${String(monthNo).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;
  return { from, to, days: lastDay };
}

function statusValue(status) {
  const value = String(status || '').toUpperCase();
  return ATTENDANCE_STATUS.has(value) ? value : 'PRESENT';
}

function dayCredit(status) {
  if (status === 'PRESENT' || status === 'PAID_LEAVE') return 1;
  if (status === 'HALF_DAY') return 0.5;
  return 0;
}

function publicStaff(row) {
  return {
    ...row,
    monthly_salary: Number(row.monthly_salary || 0),
    daily_wage: Number(row.daily_wage || 0),
    hourly_wage: Number(row.hourly_wage || 0),
    is_active: Boolean(row.is_active)
  };
}

function calculateSalary(staff, attendanceRows, monthDays, adjustments = {}) {
  const presentDays = attendanceRows.reduce((sum, row) => sum + dayCredit(row.status), 0);
  const absentDays = attendanceRows.filter((row) => row.status === 'ABSENT').length;
  const paidLeaveDays = attendanceRows.filter((row) => row.status === 'PAID_LEAVE').length;
  const overtimeHours = attendanceRows.reduce((sum, row) => sum + Number(row.overtime_hours || 0), 0);
  const dailyOverrideTotal = attendanceRows.reduce((sum, row) => {
    if (row.daily_wage_override === null || row.daily_wage_override === undefined) return sum;
    return sum + (Number(row.daily_wage_override || 0) * dayCredit(row.status));
  }, 0);

  let baseSalary = 0;
  if (staff.salary_type === 'MONTHLY') {
    baseSalary = monthDays > 0 ? (Number(staff.monthly_salary || 0) / monthDays) * presentDays : 0;
  } else if (staff.salary_type === 'HOURLY') {
    baseSalary = Number(staff.hourly_wage || 0) * attendanceRows.reduce((sum, row) => {
      if (row.status === 'PRESENT') return sum + 8;
      if (row.status === 'HALF_DAY') return sum + 4;
      return sum;
    }, 0);
  } else {
    baseSalary = Number(staff.daily_wage || 0) * presentDays;
  }

  if (dailyOverrideTotal > 0) {
    const overrideDays = attendanceRows.filter((row) => row.daily_wage_override !== null && row.daily_wage_override !== undefined).reduce((sum, row) => sum + dayCredit(row.status), 0);
    baseSalary = Math.max(baseSalary - (Number(staff.daily_wage || 0) * overrideDays), 0) + dailyOverrideTotal;
  }

  const overtimeAmount = overtimeHours * (Number(staff.hourly_wage || 0) || Number(staff.daily_wage || 0) / 8 || Number(staff.monthly_salary || 0) / monthDays / 8 || 0);
  const bonusAmount = parseMoney(adjustments.bonus_amount);
  const advanceAmount = parseMoney(adjustments.advance_amount);
  const deductionAmount = parseMoney(adjustments.deduction_amount);
  const netSalary = Math.max(baseSalary + overtimeAmount + bonusAmount - advanceAmount - deductionAmount, 0);

  return {
    working_days: monthDays,
    present_days: Number(presentDays.toFixed(2)),
    paid_leave_days: Number(paidLeaveDays.toFixed(2)),
    absent_days: Number(absentDays.toFixed(2)),
    overtime_hours: Number(overtimeHours.toFixed(2)),
    base_salary: Number(baseSalary.toFixed(2)),
    overtime_amount: Number(overtimeAmount.toFixed(2)),
    bonus_amount: bonusAmount,
    advance_amount: advanceAmount,
    deduction_amount: deductionAmount,
    net_salary: Number(netSalary.toFixed(2))
  };
}

router.use(authenticate, authorize('SERVER', 'ADMIN'));

router.get('/staff', async (req, res) => {
  const search = cleanText(req.query.search, 120);
  const activeOnly = String(req.query.active_only || '1') !== '0';
  const where = [];
  const params = [];

  if (activeOnly) where.push('is_active = 1');
  if (search) {
    where.push('(staff_name LIKE ? OR staff_code LIKE ? OR job_title LIKE ? OR department LIKE ? OR phone LIKE ?)');
    const like = `%${search}%`;
    params.push(like, like, like, like, like);
  }

  try {
    const [rows] = await db.query(
      `SELECT id, staff_code, staff_name, job_title, department, phone, alternate_phone, address,
              id_proof_type, id_proof_no, DATE_FORMAT(joining_date, '%Y-%m-%d') AS joining_date,
              salary_type, monthly_salary, daily_wage, hourly_wage,
              bank_account_name, bank_name, bank_account_no, bank_ifsc, upi_id,
              emergency_contact_name, emergency_contact_phone, notes, is_active
       FROM staff_workers
       ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY is_active DESC, staff_name
       LIMIT 500`,
      params
    );
    res.json({ rows: rows.map(publicStaff) });
  } catch (err) {
    console.error('Staff list failed:', err.message);
    res.status(500).json({ error: 'Unable to load staff.' });
  }
});

router.post('/staff', async (req, res) => {
  const id = req.body?.id ? Number.parseInt(req.body.id, 10) : null;
  const salaryType = SALARY_TYPES.has(String(req.body?.salary_type || '').toUpperCase()) ? String(req.body.salary_type).toUpperCase() : 'MONTHLY';
  const staffName = cleanText(req.body?.staff_name, 160);

  if (!staffName) {
    return res.status(400).json({ error: 'Staff name is required.' });
  }

  const payload = [
    cleanText(req.body?.staff_code, 40) || null,
    staffName,
    cleanText(req.body?.job_title, 120),
    cleanText(req.body?.department, 120),
    cleanPhone(req.body?.phone),
    cleanPhone(req.body?.alternate_phone),
    cleanText(req.body?.address, 255),
    cleanText(req.body?.id_proof_type, 40),
    cleanText(req.body?.id_proof_no, 80),
    req.body?.joining_date ? normalizeDate(req.body.joining_date, null) : null,
    salaryType,
    parseMoney(req.body?.monthly_salary),
    parseMoney(req.body?.daily_wage),
    parseMoney(req.body?.hourly_wage),
    cleanText(req.body?.bank_account_name, 150),
    cleanText(req.body?.bank_name, 150),
    cleanText(req.body?.bank_account_no, 80),
    cleanText(req.body?.bank_ifsc, 20).toUpperCase(),
    cleanText(req.body?.upi_id, 120),
    cleanText(req.body?.emergency_contact_name, 120),
    cleanPhone(req.body?.emergency_contact_phone),
    cleanText(req.body?.notes, 255),
    req.body?.is_active === false || req.body?.is_active === 0 || req.body?.is_active === '0' ? 0 : 1
  ];

  try {
    if (id) {
      await db.query(
        `UPDATE staff_workers
         SET staff_code = ?, staff_name = ?, job_title = ?, department = ?, phone = ?, alternate_phone = ?,
             address = ?, id_proof_type = ?, id_proof_no = ?, joining_date = ?, salary_type = ?,
             monthly_salary = ?, daily_wage = ?, hourly_wage = ?, bank_account_name = ?, bank_name = ?,
             bank_account_no = ?, bank_ifsc = ?, upi_id = ?, emergency_contact_name = ?,
             emergency_contact_phone = ?, notes = ?, is_active = ?
         WHERE id = ?`,
        [...payload, id]
      );
    } else {
      await db.query(
        `INSERT INTO staff_workers
         (staff_code, staff_name, job_title, department, phone, alternate_phone, address,
          id_proof_type, id_proof_no, joining_date, salary_type, monthly_salary, daily_wage, hourly_wage,
          bank_account_name, bank_name, bank_account_no, bank_ifsc, upi_id,
          emergency_contact_name, emergency_contact_phone, notes, is_active, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [...payload, req.user.username]
      );
    }
    res.json({ success: true });
  } catch (err) {
    console.error('Staff save failed:', err.message);
    res.status(500).json({ error: 'Unable to save staff. Check duplicate staff code.' });
  }
});

router.get('/attendance', async (req, res) => {
  const from = normalizeDate(req.query.from, todayIso());
  const to = normalizeDate(req.query.to, from);
  const staffId = Number.parseInt(req.query.staff_id, 10) || 0;
  const search = cleanText(req.query.search, 120);
  const where = ['a.attendance_date BETWEEN ? AND ?'];
  const params = [from <= to ? from : to, from <= to ? to : from];

  if (staffId > 0) {
    where.push('a.staff_id = ?');
    params.push(staffId);
  }
  if (search) {
    where.push('(s.staff_name LIKE ? OR s.phone LIKE ? OR s.job_title LIKE ? OR s.department LIKE ?)');
    const like = `%${search}%`;
    params.push(like, like, like, like);
  }

  try {
    const [rows] = await db.query(
      `SELECT a.id, a.staff_id, s.staff_name, s.job_title, s.department, s.phone,
              DATE_FORMAT(a.attendance_date, '%Y-%m-%d') AS attendance_date,
              a.status, TIME_FORMAT(a.in_time, '%H:%i') AS in_time, TIME_FORMAT(a.out_time, '%H:%i') AS out_time,
              a.overtime_hours, a.daily_wage_override, a.remarks
       FROM staff_attendance a
       JOIN staff_workers s ON s.id = a.staff_id
       WHERE ${where.join(' AND ')}
       ORDER BY a.attendance_date DESC, s.staff_name
       LIMIT 1000`,
      params
    );
    res.json({ rows });
  } catch (err) {
    console.error('Attendance list failed:', err.message);
    res.status(500).json({ error: 'Unable to load attendance.' });
  }
});

router.post('/attendance', async (req, res) => {
  const staffId = Number.parseInt(req.body?.staff_id, 10) || 0;
  const attendanceDate = normalizeDate(req.body?.attendance_date, todayIso());
  const status = statusValue(req.body?.status);

  if (staffId <= 0) {
    return res.status(400).json({ error: 'Select staff member.' });
  }

  try {
    await db.query(
      `INSERT INTO staff_attendance
       (staff_id, attendance_date, status, in_time, out_time, overtime_hours, daily_wage_override, remarks, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         status = VALUES(status),
         in_time = VALUES(in_time),
         out_time = VALUES(out_time),
         overtime_hours = VALUES(overtime_hours),
         daily_wage_override = VALUES(daily_wage_override),
         remarks = VALUES(remarks),
         updated_at = CURRENT_TIMESTAMP`,
      [
        staffId,
        attendanceDate,
        status,
        cleanTime(req.body?.in_time),
        cleanTime(req.body?.out_time),
        parseMoney(req.body?.overtime_hours),
        req.body?.daily_wage_override === '' || req.body?.daily_wage_override === undefined ? null : parseMoney(req.body?.daily_wage_override),
        cleanText(req.body?.remarks, 255),
        req.user.username
      ]
    );
    res.json({ success: true });
  } catch (err) {
    console.error('Attendance save failed:', err.message);
    res.status(500).json({ error: 'Unable to save attendance.' });
  }
});

router.get('/monthly-sheet', async (req, res) => {
  const month = cleanMonth(req.query.month);
  const search = cleanText(req.query.search, 120);
  const { from, to, days } = monthRange(month);
  const staffWhere = ['s.is_active = 1'];
  const params = [];

  if (search) {
    staffWhere.push('(s.staff_name LIKE ? OR s.phone LIKE ? OR s.job_title LIKE ? OR s.department LIKE ?)');
    const like = `%${search}%`;
    params.push(like, like, like, like);
  }

  try {
    const [staffRows] = await db.query(
      `SELECT s.*
       FROM staff_workers s
       WHERE ${staffWhere.join(' AND ')}
       ORDER BY s.staff_name`,
      params
    );
    const [attendanceRows] = await db.query(
      `SELECT * FROM staff_attendance WHERE attendance_date BETWEEN ? AND ?`,
      [from, to]
    );
    const [sheetRows] = await db.query(
      `SELECT * FROM staff_salary_sheets WHERE salary_month = ?`,
      [month]
    );
    const attendanceByStaff = attendanceRows.reduce((acc, row) => {
      acc[row.staff_id] = acc[row.staff_id] || [];
      acc[row.staff_id].push(row);
      return acc;
    }, {});
    const sheetByStaff = sheetRows.reduce((acc, row) => ({ ...acc, [row.staff_id]: row }), {});
    const rows = staffRows.map((staff) => {
      const saved = sheetByStaff[staff.id];
      const calculated = calculateSalary(staff, attendanceByStaff[staff.id] || [], days, saved || {});
      return {
        staff: publicStaff(staff),
        salary_month: month,
        ...(saved || {}),
        ...calculated,
        id: saved?.id || null,
        payment_status: saved?.payment_status || 'PENDING',
        payment_date: saved?.payment_date || null,
        payment_mode: saved?.payment_mode || 'Cash',
        reference_no: saved?.reference_no || '',
        remarks: saved?.remarks || '',
        posted_to_cash_ledger: Boolean(saved?.posted_to_cash_ledger)
      };
    });
    const totals = rows.reduce((acc, row) => ({
      staff_count: acc.staff_count + 1,
      net_salary: acc.net_salary + Number(row.net_salary || 0),
      pending_salary: acc.pending_salary + (row.payment_status === 'PAID' ? 0 : Number(row.net_salary || 0)),
      paid_salary: acc.paid_salary + (row.payment_status === 'PAID' ? Number(row.net_salary || 0) : 0)
    }), { staff_count: 0, net_salary: 0, pending_salary: 0, paid_salary: 0 });
    res.json({ month, from, to, rows, totals });
  } catch (err) {
    console.error('Monthly salary sheet failed:', err.message);
    res.status(500).json({ error: 'Unable to load monthly salary sheet.' });
  }
});

router.post('/salary-sheet', async (req, res) => {
  const staffId = Number.parseInt(req.body?.staff_id, 10) || 0;
  const month = cleanMonth(req.body?.salary_month);
  const { from, to, days } = monthRange(month);
  const paymentStatus = req.body?.payment_status === 'PAID' ? 'PAID' : 'PENDING';
  const paymentMode = PAYMENT_MODES.has(req.body?.payment_mode) ? req.body.payment_mode : 'Cash';
  const paymentDate = req.body?.payment_date ? normalizeDate(req.body.payment_date, todayIso()) : null;

  if (staffId <= 0) {
    return res.status(400).json({ error: 'Select staff member.' });
  }

  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();
    const [[staff]] = await connection.query('SELECT * FROM staff_workers WHERE id = ? LIMIT 1', [staffId]);
    if (!staff) {
      await connection.rollback();
      return res.status(404).json({ error: 'Staff member not found.' });
    }
    const [attendance] = await connection.query(
      'SELECT * FROM staff_attendance WHERE staff_id = ? AND attendance_date BETWEEN ? AND ?',
      [staffId, from, to]
    );
    const salary = calculateSalary(staff, attendance, days, req.body || {});

    await connection.query(
      `INSERT INTO staff_salary_sheets
       (staff_id, salary_month, working_days, present_days, paid_leave_days, absent_days, overtime_hours,
        base_salary, overtime_amount, bonus_amount, advance_amount, deduction_amount, net_salary,
        payment_status, payment_date, payment_mode, reference_no, remarks, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
        working_days = VALUES(working_days),
        present_days = VALUES(present_days),
        paid_leave_days = VALUES(paid_leave_days),
        absent_days = VALUES(absent_days),
        overtime_hours = VALUES(overtime_hours),
        base_salary = VALUES(base_salary),
        overtime_amount = VALUES(overtime_amount),
        bonus_amount = VALUES(bonus_amount),
        advance_amount = VALUES(advance_amount),
        deduction_amount = VALUES(deduction_amount),
        net_salary = VALUES(net_salary),
        payment_status = VALUES(payment_status),
        payment_date = VALUES(payment_date),
        payment_mode = VALUES(payment_mode),
        reference_no = VALUES(reference_no),
        remarks = VALUES(remarks),
        updated_at = CURRENT_TIMESTAMP`,
      [
        staffId, month, salary.working_days, salary.present_days, salary.paid_leave_days, salary.absent_days, salary.overtime_hours,
        salary.base_salary, salary.overtime_amount, salary.bonus_amount, salary.advance_amount, salary.deduction_amount, salary.net_salary,
        paymentStatus, paymentDate, paymentMode, cleanText(req.body?.reference_no, 120), cleanText(req.body?.remarks, 255), req.user.username
      ]
    );
    const [[sheet]] = await connection.query('SELECT * FROM staff_salary_sheets WHERE staff_id = ? AND salary_month = ? LIMIT 1', [staffId, month]);

    if (paymentStatus === 'PAID' && !sheet.posted_to_cash_ledger) {
      await connection.query(
        `INSERT INTO counter_cash_ledger_entries
         (entry_date, counter_no, source_type, source_id, account_name, details, direction, amount, payment_mode, created_by)
         VALUES (?, NULL, 'STAFF_SALARY', ?, ?, ?, 'CR', ?, ?, ?)`,
        [
          paymentDate || todayIso(),
          sheet.id,
          `Staff Salary - ${staff.staff_name}`,
          `${month} salary payment ${cleanText(req.body?.remarks, 120)}`,
          salary.net_salary,
          paymentMode,
          req.user.username
        ]
      );
      await connection.query('UPDATE staff_salary_sheets SET posted_to_cash_ledger = 1 WHERE id = ?', [sheet.id]);
    }

    await connection.commit();
    res.json({ success: true, salary });
  } catch (err) {
    await connection.rollback();
    console.error('Salary sheet save failed:', err.message);
    res.status(500).json({ error: 'Unable to save salary sheet.' });
  } finally {
    connection.release();
  }
});

module.exports = router;
