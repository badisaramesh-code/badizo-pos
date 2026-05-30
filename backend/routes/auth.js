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

module.exports = router;
