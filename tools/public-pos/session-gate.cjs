const http = require('node:http');
const { createHash } = require('node:crypto');
const mysql = require('mysql2/promise');

const env = process.env;
if (env.BADIZO_NODE_ROLE !== 'cloud-standby' || !env.DB_NAME || !env.DB_USER) {
  throw Error('Configure the cloud database before enabling public sign-in.');
}
const pool = mysql.createPool({
  host: env.DB_HOST || 'localhost', port: Number(env.DB_PORT || 3306),
  database: env.DB_NAME, user: env.DB_USER, password: env.DB_PASSWORD,
  connectionLimit: 3, queueLimit: 30
});
const sessions = new Map();
const digest = value => createHash('sha256').update(value).digest('hex');
const failure = JSON.stringify({ error: 'Sign-in failed.' });
function send(res, status, body = '') {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(body);
}
async function account(username) {
  const [rows] = await pool.execute(
    'SELECT id, username, role, counter_no, password_hash FROM users WHERE username=? AND is_active=1 LIMIT 1',
    [username]
  );
  return rows[0];
}
function fingerprint(row) {
  return digest(JSON.stringify([row.id, row.username, row.role, row.counter_no, row.password_hash]));
}
async function login(req, res) {
  let input = '';
  for await (const chunk of req) {
    input += chunk;
    if (Buffer.byteLength(input) > 4096) return send(res, 413);
  }
  let data;
  try { data = JSON.parse(input); } catch { return send(res, 400); }
  if (typeof data?.username !== 'string' || typeof data.password !== 'string' ||
      data.username.length > 100 || data.password.length < 10 ||
      data.password.toLowerCase() === data.username.trim().toLowerCase()) return send(res, 401, failure);
  const row = await account(data.username.trim());
  if (!row) return send(res, 401, failure);
  const response = await fetch('http://127.0.0.1:5000/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': req.headers['x-real-ip'] || '' },
    body: input, signal: AbortSignal.timeout(12000)
  });
  if (!response.ok) return send(res, response.status === 401 ? 401 : 503, failure);
  const result = await response.json();
  if (!result.token || result.user?.id !== row.id || result.user.role !== row.role) return send(res, 401, failure);
  sessions.set(digest(result.token), {
    username: row.username, fingerprint: fingerprint(row), expires: Date.now() + 18 * 3600000
  });
  send(res, 200, JSON.stringify(result));
}
setInterval(() => {
  for (const [key, session] of sessions) if (session.expires <= Date.now()) sessions.delete(key);
}, 60000).unref();
http.createServer(async (req, res) => {
  try {
    if (req.url === '/login' && req.method === 'POST') return await login(req, res);
    const token = /^Bearer (\S+)$/i.exec(req.headers.authorization || '')?.[1];
    if (!token) return send(res, 401);
    const key = digest(token);
    const session = sessions.get(key);
    if (!session || session.expires <= Date.now()) return send(res, 401);
    if (req.url === '/logout' && req.method === 'POST') {
      sessions.delete(key);
      return send(res, 200, '{}');
    }
    if (req.url !== '/verify') return send(res, 404);
    const row = await account(session.username);
    if (!row || fingerprint(row) !== session.fingerprint) {
      sessions.delete(key);
      return send(res, 401);
    }
    send(res, 204);
  } catch { send(res, 503); }
}).listen(5081, '127.0.0.1');
