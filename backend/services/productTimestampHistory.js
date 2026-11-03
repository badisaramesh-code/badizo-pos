async function ensureProductTimestampHistory(connection) {
  const [columns] = await connection.query("SHOW COLUMNS FROM products LIKE 'previous_updated_at'");
  if (!columns.length) await connection.query('ALTER TABLE products ADD COLUMN previous_updated_at TIMESTAMP NULL DEFAULT NULL AFTER updated_at');
  const [triggers] = await connection.query("SELECT TRIGGER_NAME FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = DATABASE() AND TRIGGER_NAME = 'products_previous_update_timestamp'");
  if (!triggers.length) await connection.query(`CREATE TRIGGER products_previous_update_timestamp BEFORE UPDATE ON products FOR EACH ROW
    BEGIN
      IF NOT (NEW.updated_at <=> OLD.updated_at) THEN
        SET NEW.previous_updated_at = COALESCE(OLD.updated_at, OLD.created_at);
      END IF;
    END`);
}
module.exports = { ensureProductTimestampHistory };
