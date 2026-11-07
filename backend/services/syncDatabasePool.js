const mysql = require('mysql2/promise');

// Network transfers retain advisory-lock connections. Keep those slots separate
// from checkout, and bound both connection demand and database lock waits.
function createSyncDatabasePool({env = process.env, createPool = mysql.createPool} = {}) {
  const pool = createPool({
    host: env.DB_HOST || 'localhost', port: Number.parseInt(env.DB_PORT, 10) || 3306,
    user: env.DB_USER || 'root', password: env.DB_PASSWORD || '1234',
    database: env.DB_NAME || 'badizo_pos', connectionLimit: 4, maxIdle: 4,
    waitForConnections: true, queueLimit: 8, connectTimeout: 5000,
    idleTimeout: 30000, enableKeepAlive: true
  });
  const checkout = pool.getConnection.bind(pool);
  pool.getConnection = async () => {
    const connection = await checkout();
    try {
      await connection.query('SET SESSION innodb_lock_wait_timeout = 2, lock_wait_timeout = 2');
      return connection;
    } catch (error) { connection.destroy(); throw error; }
  };
  for (const method of ['query', 'execute']) {
    pool[method] = async (...args) => {
      const connection = await pool.getConnection();
      try { return await connection[method](...args); }
      finally { connection.release(); }
    };
  }
  return pool;
}
module.exports = {createSyncDatabasePool};
