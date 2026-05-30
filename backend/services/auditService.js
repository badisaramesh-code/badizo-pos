const db = require('../config/db');

async function writeAuditLog({
  user,
  action,
  entityType,
  entityId = null,
  details = null,
  connection = db
}) {
  try {
    await connection.query(
      `INSERT INTO audit_logs (user_id, username, role, action, entity_type, entity_id, details)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        user?.id || null,
        user?.username || 'system',
        user?.role || 'SYSTEM',
        action,
        entityType,
        entityId,
        details ? JSON.stringify(details) : null
      ]
    );
  } catch (err) {
    console.error('Audit log failed:', err.message);
  }
}

module.exports = {
  writeAuditLog
};
