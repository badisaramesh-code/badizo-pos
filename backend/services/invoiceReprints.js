async function ensureSchema(connection) {
  await connection.query(`CREATE TABLE IF NOT EXISTS invoice_reprints (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    invoice_no VARCHAR(120) NOT NULL,
    username VARCHAR(100) NOT NULL,
    print_mode VARCHAR(20) NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_invoice_reprints_created (created_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
}

async function record(pool, invoiceNo, username, printMode) {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const [result] = await connection.query('UPDATE invoices SET reprint_count = reprint_count + 1 WHERE invoice_no = ?', [invoiceNo]);
    if (!result.affectedRows) { await connection.rollback(); return false; }
    await connection.query('INSERT INTO invoice_reprints (invoice_no,username,print_mode) VALUES (?,?,?)', [invoiceNo, username, printMode]);
    await connection.commit();
    return true;
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally { connection.release(); }
}

module.exports = {ensureSchema, record};
