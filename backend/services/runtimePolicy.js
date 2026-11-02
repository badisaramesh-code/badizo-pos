function isCloudNode(env = process.env) {
  return ['cloud-standby', 'cloud-active'].includes(env.BADIZO_NODE_ROLE);
}
function bindHost(value, env = process.env) {
  const host = String(value || '').trim();
  if (isCloudNode(env)) {
    if (host && !['localhost', '127.0.0.1'].includes(host)) throw new Error('Cloud POS must bind to IPv4 loopback; use a private tunnel or secured proxy.');
    return '127.0.0.1';
  }
  return !host || ['localhost', '127.0.0.1', '::1'].includes(host.toLowerCase()) ? '0.0.0.0' : host;
}
function cloudWriteGuard(req, res, next) {
  if (process.env.BADIZO_NODE_ROLE !== 'cloud-standby' || ['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  if (['/auth/login', '/auth/logout', '/auth/logout-beacon'].includes(req.path)) return next();
  return res.status(409).json({ error: 'Cloud billing is in standby. Activate it only after local billing and incoming sync are stopped.' });
}
function invoicePrefix(env = process.env) { return isCloudNode(env) ? 'CL' : 'BZ'; }
module.exports = { isCloudNode, bindHost, cloudWriteGuard, invoicePrefix };
