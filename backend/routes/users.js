const crypto = require('crypto');
const express = require('express');
const router = express.Router();
const db = require('../config/db');
const { authenticate, authorize } = require('../middleware/auth');
const { writeAuditLog } = require('../services/auditService');

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.pbkdf2Sync(password, salt, 100000, 64, 'sha512').toString('hex');
  return `${salt}:${hash}`;
}

function publicUser(row) {
  return {
    id: row.id,
    username: row.username,
    role: row.role,
    counter_no: row.counter_no,
    is_active: Boolean(row.is_active),
    created_at: row.created_at,
    updated_at: row.updated_at
  };
}

router.use(authenticate, authorize('SERVER', 'ADMIN'));

router.get('/', async (_req, res) => {
  try {
    const [rows] = await db.query(
      `SELECT id, username, role, counter_no, is_active, created_at, updated_at
       FROM users
       ORDER BY role ASC, username ASC`
    );
    res.json(rows.map(publicUser));
  } catch (err) {
    console.error('User list failed:', err.message);
    res.status(500).json({ error: 'Unable to fetch users.' });
  }
});

router.post('/', async (req, res) => {
  const id = req.body?.id ? Number.parseInt(req.body.id, 10) : null;
  const username = String(req.body?.username || '').trim();
  const password = String(req.body?.password || '');
  const role = ['SERVER', 'ADMIN', 'COUNTER'].includes(req.body?.role) ? req.body.role : 'COUNTER';
  const counterNo = role === 'COUNTER' ? Number.parseInt(req.body?.counter_no, 10) || 1 : null;
  const isActive = req.body?.is_active === false ? 0 : 1;

  if (!username) {
    return res.status(400).json({ error: 'Username is required.' });
  }

  if (!id && password.length < 6) {
    return res.status(400).json({ error: 'New user password must be at least 6 characters.' });
  }

  try {
    if (id) {
      const values = [username, role, counterNo, isActive];
      let passwordSql = '';

      if (password) {
        if (password.length < 6) {
          return res.status(400).json({ error: 'Password must be at least 6 characters.' });
        }
        passwordSql = ', password_hash = ?';
        values.push(hashPassword(password));
      }

      values.push(id);
      await db.query(
        `UPDATE users
         SET username = ?, role = ?, counter_no = ?, is_active = ?${passwordSql}
         WHERE id = ?`,
        values
      );

      await writeAuditLog({
        user: req.user,
        action: 'USER_UPDATED',
        entityType: 'USER',
        entityId: username,
        details: { role, counterNo, isActive: Boolean(isActive), passwordChanged: Boolean(password) }
      });
    } else {
      await db.query(
        `INSERT INTO users (username, password_hash, role, counter_no, is_active)
         VALUES (?, ?, ?, ?, ?)`,
        [username, hashPassword(password), role, counterNo, isActive]
      );

      await writeAuditLog({
        user: req.user,
        action: 'USER_CREATED',
        entityType: 'USER',
        entityId: username,
        details: { role, counterNo, isActive: Boolean(isActive) }
      });
    }

    const [rows] = await db.query(
      `SELECT id, username, role, counter_no, is_active, created_at, updated_at
       FROM users
       WHERE username = ?
       LIMIT 1`,
      [username]
    );
    res.json(publicUser(rows[0]));
  } catch (err) {
    console.error('User save failed:', err.message);
    if (err.code === 'ER_DUP_ENTRY') {
      return res.status(400).json({ error: 'Username already exists.' });
    }
    res.status(500).json({ error: 'Unable to save user.' });
  }
});

module.exports = router;
