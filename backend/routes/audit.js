const express = require('express');
const router = express.Router();
const db = require('../config/db');
const { authenticate, authorize } = require('../middleware/auth');

router.use(authenticate, authorize('SERVER', 'ADMIN'));

router.get('/', async (req, res) => {
  try {
    const limit = Math.min(Math.max(Number.parseInt(req.query.limit, 10) || 100, 10), 500);
    const [rows] = await db.query(
      `SELECT id, username, role, action, entity_type, entity_id, details, created_at
       FROM audit_logs
       ORDER BY created_at DESC
       LIMIT ?`,
      [limit]
    );

    res.json(rows.map((row) => ({
      ...row,
      details: typeof row.details === 'string' ? JSON.parse(row.details || '{}') : row.details
    })));
  } catch (err) {
    console.error('Audit list failed:', err.message);
    res.status(500).json({ error: 'Unable to fetch audit logs.' });
  }
});

module.exports = router;
