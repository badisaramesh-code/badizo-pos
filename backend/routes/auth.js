const crypto = require('crypto');
const express = require('express');
const jwt = require('jsonwebtoken');
const db = require('../config/db');
const { JWT_SECRET, authenticate, authorize } = require('../middleware/auth');

const router = express.Router();

function verifyPassword(password, storedValue) {
  const [salt, storedHash] = String(storedValue || '').split(':');
  if (!salt || !storedHash) return false;

  const candidateHash = crypto.pbkdf2Sync(password, salt, 100000, 64, 'sha512').toString('hex');
  return crypto.timingSafeEqual(Buffer.from(candidateHash, 'hex'), Buffer.from(storedHash, 'hex'));
}

function publicUser(row) {
  return {
    id: row.id,
    username: row.username,
    role: row.role,
    counter_no: row.counter_no
  };
}

function requestIp(req) {
  return String(req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '')
    .split(',')[0]
    .trim()
    .slice(0, 80);
}

function requestUserAgent(req) {
  return String(req.headers['user-agent'] || '').slice(0, 255);
}

async function recordSessionEvent(req, user, sessionId, eventType) {
  await db.query(
    `INSERT INTO user_session_events
      (session_id, user_id, username, person_name, role, counter_no, event_type, ip_address, user_agent)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      sessionId,
      user.id || null,
      user.username || 'unknown',
      String(user.person_name || '').trim().slice(0, 120),
      user.role || 'UNKNOWN',
      user.counter_no || null,
      eventType,
      requestIp(req),
      requestUserAgent(req)
    ]
  );
}

function loginOption(row) {
  const counterNo = Number(row.counter_no || 0);
  const adminMatch = String(row.username || '').match(/^admin([1-9]\d*)$/i);
  const label = row.role === 'COUNTER' && counterNo > 0
    ? `Counter ${counterNo}`
    : adminMatch
      ? `Admin ${adminMatch[1]}`
      : String(row.role || row.username).toLowerCase().replace(/^\w/, (char) => char.toUpperCase());

  return {
    username: row.username,
    label,
    role: row.role,
    counter_no: row.counter_no
  };
}

router.get('/login-options', async (req, res) => {
  try {
    const [rows] = await db.query(
      `SELECT username, role, counter_no
       FROM users
       WHERE is_active = 1
       ORDER BY
         FIELD(role, 'SERVER', 'ADMIN', 'SECURITY', 'COUNTER'),
         COALESCE(counter_no, 0),
         username`
    );

    res.json({ options: rows.map(loginOption) });
  } catch (err) {
    console.error('Login options failed:', err.message);
    res.status(500).json({ error: 'Unable to load login options.' });
  }
});

router.post('/login', async (req, res) => {
  const { username, password, person_name: personName } = req.body || {};

  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password are required.' });
  }
  const cleanPersonName = String(personName || '').trim();
  if (!cleanPersonName) {
    return res.status(400).json({ error: 'Person name is required.' });
  }

  try {
    const [rows] = await db.query(
      `SELECT id, username, password_hash, role, counter_no, is_active
       FROM users
       WHERE username = ?
       LIMIT 1`,
      [username.trim()]
    );

    const user = rows[0];
    if (!user || !user.is_active || !verifyPassword(password, user.password_hash)) {
      return res.status(401).json({ error: 'Invalid username or password.' });
    }

    const safeUser = publicUser(user);
    safeUser.person_name = cleanPersonName.slice(0, 120);
    const sessionId = crypto.randomUUID();
    await recordSessionEvent(req, safeUser, sessionId, 'LOGIN');
    const token = jwt.sign({ ...safeUser, session_id: sessionId }, JWT_SECRET, { expiresIn: '12h' });
    res.json({ token, user: safeUser });
  } catch (err) {
    console.error('Login failed:', err.message);
    res.status(500).json({ error: 'Unable to login.' });
  }
});

router.post('/logout', authenticate, async (req, res) => {
  try {
    const sessionId = String(req.user?.session_id || crypto.randomUUID()).slice(0, 80);
    await recordSessionEvent(req, req.user, sessionId, 'LOGOUT');
    res.json({ success: true });
  } catch (err) {
    console.error('Logout record failed:', err.message);
    res.status(500).json({ error: 'Unable to record logout.' });
  }
});

router.post('/logout-beacon', async (req, res) => {
  const token = String(req.body?.token || '').trim();
  if (!token) {
    return res.status(204).end();
  }

  try {
    const user = jwt.verify(token, JWT_SECRET);
    const sessionId = String(user.session_id || crypto.randomUUID()).slice(0, 80);
    await recordSessionEvent(req, user, sessionId, 'LOGOUT');
    res.status(204).end();
  } catch (err) {
    res.status(204).end();
  }
});

router.get('/session-events', authenticate, authorize('SERVER', 'ADMIN'), async (req, res) => {
  const limit = Math.min(Number.parseInt(req.query.limit, 10) || 200, 500);

  try {
    const [rows] = await db.query(
      `SELECT id, session_id, user_id, username, person_name, role, counter_no, event_type, ip_address, user_agent, created_at
       FROM user_session_events
       ORDER BY created_at DESC, id DESC
       LIMIT ?`,
      [limit]
    );
    const [summary] = await db.query(
      `SELECT username, person_name, role, counter_no, event_type, COUNT(*) AS event_count, MAX(created_at) AS last_at
       FROM user_session_events
       GROUP BY username, person_name, role, counter_no, event_type
       ORDER BY username, event_type`
    );

    res.json({ rows, summary });
  } catch (err) {
    console.error('Session events failed:', err.message);
    res.status(500).json({ error: 'Unable to load login/logout history.' });
  }
});

router.get('/me', authenticate, (req, res) => {
  res.json({ user: req.user });
});

router.post('/approve-sensitive-mode', authenticate, async (req, res) => {
  const { username, password, reason } = req.body || {};

  if (!username || !password) {
    return res.status(400).json({ error: 'Supervisor username and password are required.' });
  }

  try {
    const [rows] = await db.query(
      `SELECT id, username, password_hash, role, counter_no, is_active
       FROM users
       WHERE username = ?
       LIMIT 1`,
      [String(username).trim()]
    );

    const supervisor = rows[0];
    const allowedRole = ['SERVER', 'ADMIN'].includes(supervisor?.role);
    if (!supervisor || !supervisor.is_active || !allowedRole || !verifyPassword(password, supervisor.password_hash)) {
      return res.status(401).json({ error: 'Supervisor approval failed.' });
    }

    res.json({
      success: true,
      approved_by: supervisor.username,
      role: supervisor.role,
      reason: String(reason || '').slice(0, 120)
    });
  } catch (err) {
    console.error('Sensitive mode approval failed:', err.message);
    res.status(500).json({ error: 'Unable to verify supervisor approval.' });
  }
});

module.exports = router;
