const crypto = require('crypto');
const express = require('express');
const jwt = require('jsonwebtoken');
const db = require('../config/db');
const { JWT_SECRET, authenticate } = require('../middleware/auth');

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
         FIELD(role, 'SERVER', 'ADMIN', 'COUNTER'),
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
  const { username, password } = req.body || {};

  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password are required.' });
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
    const token = jwt.sign(safeUser, JWT_SECRET, { expiresIn: '12h' });
    res.json({ token, user: safeUser });
  } catch (err) {
    console.error('Login failed:', err.message);
    res.status(500).json({ error: 'Unable to login.' });
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
