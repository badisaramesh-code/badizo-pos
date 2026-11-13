'use strict';

// Optional diagnostic history only. Never prune invoices, unresolved requests,
// idempotency records or abandonment markers through this policy.
const RETENTION_DAYS = 7;
const enabled = (env = process.env) => env.BADIZO_CHECKOUT_AUDIT_ENABLED === 'true';
function state(env = process.env) { return { enabled: enabled(env), retentionDays: RETENTION_DAYS }; }
async function record(connection, event, env = process.env) {
  if (!enabled(env)) return { skipped: true };
  await connection.query('INSERT INTO checkout_recovery_events(checkout_request_id,actor,action,outcome,invoice_no) VALUES(?,?,?,?,?)',
    [event.id, String(event.actor).slice(0,100), String(event.action).slice(0,20), String(event.outcome).slice(0,20), event.invoiceNo || null]);
  return { recorded: true };
}
async function history(connection, id, env = process.env) {
  if (!enabled(env)) return [];
  const [rows] = await connection.query('SELECT actor,action,outcome,invoice_no,created_at FROM checkout_recovery_events WHERE checkout_request_id=? AND created_at>=CURRENT_TIMESTAMP-INTERVAL 7 DAY ORDER BY id DESC LIMIT 200', [id]);
  return rows;
}
async function ensureRetentionIndex(connection, env = process.env) {
  if (!enabled(env)) return;
  const [rows] = await connection.query("SELECT INDEX_NAME FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='checkout_recovery_events' AND COLUMN_NAME='created_at' AND SEQ_IN_INDEX=1 LIMIT 1");
  if (!rows.length) await connection.query('ALTER TABLE checkout_recovery_events ADD INDEX idx_checkout_event_created(created_at)');
}
async function prune(connection, { limit = 1000 } = {}) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw Error('Invalid checkout-history cleanup batch.');
  const [result] = await connection.query('DELETE FROM checkout_recovery_events WHERE created_at<CURRENT_TIMESTAMP-INTERVAL 7 DAY ORDER BY created_at LIMIT ' + limit);
  return Number(result.affectedRows || 0);
}
function startRetention(pool, env = process.env) {
  if (!enabled(env)) return () => {};
  let busy = false, stopped = false;
  async function run() {
    if (busy || stopped) return;
    busy = true;
    try {
      await pool.ready;
      await ensureRetentionIndex(pool, env);
      // Bounded indexed cleanup, outside checkout/release transactions.
      for (let batch=0; batch<10 && !stopped; batch++) if (await prune(pool) < 1000) break;
    } catch { console.warn('Optional checkout history cleanup is pending.'); }
    finally { busy = false; }
  }
  const timer = setInterval(run, 60 * 60 * 1000); timer.unref?.();
  void run();
  return () => { stopped = true; clearInterval(timer); };
}
module.exports = { RETENTION_DAYS, enabled, state, record, history, ensureRetentionIndex, prune, startRetention };
