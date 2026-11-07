function isCloudNode(env = process.env) {
  return ['cloud-standby', 'cloud-active'].includes(env.BADIZO_NODE_ROLE);
}
function bindHost(value, env = process.env) {
  const host = String(value || '').trim();
  if (isCloudNode(env) || env.BADIZO_LOOPBACK_ONLY === 'true') {
    if (host && !['localhost', '127.0.0.1'].includes(host)) throw new Error('Cloud POS must bind to IPv4 loopback; use a private tunnel or secured proxy.');
    return '127.0.0.1';
  }
  return !host || ['localhost', '127.0.0.1', '::1'].includes(host.toLowerCase()) ? '0.0.0.0' : host;
}
function cloudWriteGuard(req, res, next) {
  if (process.env.BADIZO_NODE_ROLE !== 'cloud-standby' || ['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  if (process.env.BADIZO_RUNTIME_BINDING) {
    try { const state=require('./recoveryRuntimeBinding').status(); if(state?.phase==='active'&&state.billingMode==='active') return next(); } catch {}
  }
  if (process.env.BADIZO_RECOVERY_CONTROL_CONFIG && /^\/(recovery-control|recovery-baseline|recovery-preparation)(?:\/|$)/.test(req.path)) return next();
  if (process.env.BADIZO_SYNC_ENROLLMENT_CONFIG && /^\/sync\/(events|feed\/ack|handoff(?:\/flush)?)$/.test(req.path)) return next();
  if (process.env.BADIZO_SYNC_ENROLLMENT_CONFIG && /^\/recovery-cases(?:\/|$)/.test(req.path)) return next();
  if (['/auth/login', '/auth/logout', '/auth/logout-beacon'].includes(req.path)) return next();
  if (req.method === 'POST' && req.path === '/cloud-software') return next();
  if (req.method === 'POST' && req.path === '/auth/change-password') return next();
  return res.status(409).json({ error: 'Cloud billing is in standby. Activate it only after local billing and incoming sync are stopped.' });
}
function invoicePrefix(env = process.env) { return isCloudNode(env) ? 'CL' : 'BZ'; }
module.exports = { isCloudNode, bindHost, cloudWriteGuard, invoicePrefix };
