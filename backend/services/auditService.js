const binding = require('./recoveryRuntimeBinding');
const FAILURE = 'REQUEST_FAILED';

function canWrite() {
  const state = binding.counterBillingState();
  return !state || state.mode === 'active';
}

// Existing business-action callers may supply successful events. They produce no audit I/O.
async function writeAuditLog({ user, action, entityType, details, connection }) {
  if (action !== FAILURE) return;
  const pool = connection || require('../config/db');
  await pool.query(
    'INSERT INTO audit_logs (user_id,username,role,action,entity_type,details) VALUES (?,?,?,?,?,?)',
    [user.id || null, user.username, user.role, FAILURE, entityType, JSON.stringify(details)]
  );
}

function recordRequestFailure(req, res, next) {
  res.once('finish', () => {
    const status = res.statusCode;
    if (status < 400 || !req.user || typeof req.route?.path !== 'string') return;
    // Optional lookups and ordinary polling misses are expected. Unauthenticated probes
    // must not create database rows on a public cloud server.
    if (status < 500 && ['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return;
    if (!canWrite()) return;
    const operation = req.route.path;
    const area = req.originalUrl.split('?')[0].split('/')[2];
    if (!/^[a-z][a-z0-9-]{0,60}$/.test(area) || area === 'audit') return;
    // Record only the route template; never store request bodies, URLs or credentials.
    const details = {method: req.method, route: operation, status};
    if (res.locals?.auditFailureCode) details.code = res.locals.auditFailureCode;
    binding.withWriteLease(() => writeAuditLog({
      user: req.user, action: FAILURE, entityType: area,
      details
    })).catch(() => console.error('Could not persist request failure.'));
  });
  next();
}

function startErrorRetention(pool) {
  let busy = false;
  async function prune() {
    if (busy || !canWrite()) return;
    busy = true;
    try {
      await pool.ready;
      await binding.withWriteLease(() => pool.query(
        "DELETE FROM audit_logs WHERE action = 'REQUEST_FAILED' AND created_at < CURRENT_TIMESTAMP - INTERVAL 7 DAY ORDER BY created_at LIMIT 1000"
      ));
    } catch { console.warn('System error history cleanup is pending.'); }
    finally { busy = false; }
  }
  const timer = setInterval(prune, 60 * 60 * 1000);
  timer.unref();
  return () => clearInterval(timer);
}

module.exports = { writeAuditLog, recordRequestFailure, startErrorRetention };
