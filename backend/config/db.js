const mysql = require('mysql2/promise');
const crypto = require('crypto');
require('dotenv').config();

const pool = mysql.createPool({
  host: process.env.DB_HOST || 'localhost',
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '1234',
  database: process.env.DB_NAME || 'badizo_pos',
  waitForConnections: true,
  connectionLimit: 15,
  queueLimit: 0
});

async function ensureColumn(connection, tableName, columnName, definition) {
  const [rows] = await connection.query(
    `SELECT COLUMN_NAME
     FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
    [tableName, columnName]
  );

  if (rows.length === 0) {
    await connection.query(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition}`);
  }
}

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.pbkdf2Sync(password, salt, 100000, 64, 'sha512').toString('hex');
  return `${salt}:${hash}`;
}

(async () => {
  let connection;

  try {
    connection = await pool.getConnection();
    console.log('Database connected.');

    await connection.query(`
      CREATE TABLE IF NOT EXISTS users (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        username VARCHAR(100) NOT NULL UNIQUE,
        password_hash VARCHAR(255) NOT NULL,
        role ENUM('SERVER', 'ADMIN', 'COUNTER') NOT NULL DEFAULT 'COUNTER',
        counter_no INT DEFAULT NULL,
        is_active TINYINT(1) NOT NULL DEFAULT 1,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX idx_user_role (role),
        INDEX idx_user_counter (counter_no)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    `);

    await connection.query(`
      CREATE TABLE IF NOT EXISTS products (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        product_code VARCHAR(60) DEFAULT NULL UNIQUE,
        barcode VARCHAR(120) NOT NULL UNIQUE,
        product_name VARCHAR(255) NOT NULL,
        hsn_code VARCHAR(20) DEFAULT NULL,
        gst_percent DECIMAL(5,2) NOT NULL DEFAULT 0.00,
        unit_type VARCHAR(20) NOT NULL DEFAULT 'Nos',
        mrp DECIMAL(10,2) NOT NULL DEFAULT 0.00,
        purchase_price DECIMAL(10,2) NOT NULL DEFAULT 0.00,
        sale_price DECIMAL(10,2) NOT NULL DEFAULT 0.00,
        wholesale_price DECIMAL(10,2) NOT NULL DEFAULT 0.00,
        discount_type ENUM('PERCENT', 'VALUE') NOT NULL DEFAULT 'PERCENT',
        discount_value DECIMAL(10,2) NOT NULL DEFAULT 0.00,
        bulk_discount_value DECIMAL(10,2) NOT NULL DEFAULT 0.00,
        is_free_item TINYINT(1) NOT NULL DEFAULT 0,
        stock_qty DECIMAL(10,2) NOT NULL DEFAULT 0.00,
        min_stock_alert DECIMAL(10,2) NOT NULL DEFAULT 10.00,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX idx_product_code (product_code),
        INDEX idx_barcode (barcode),
        INDEX idx_product_name (product_name)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    `);

    await connection.query(`
      CREATE TABLE IF NOT EXISTS invoices (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        invoice_no VARCHAR(50) NOT NULL UNIQUE,
        customer_phone VARCHAR(15) DEFAULT NULL,
        customer_name VARCHAR(150) DEFAULT 'Walk-in Customer',
        customer_address VARCHAR(255) DEFAULT NULL,
        sub_total DECIMAL(10,2) NOT NULL DEFAULT 0.00,
        gst_total DECIMAL(10,2) NOT NULL DEFAULT 0.00,
        grand_total DECIMAL(10,2) NOT NULL DEFAULT 0.00,
        cash_received DECIMAL(10,2) NOT NULL DEFAULT 0.00,
        change_returned DECIMAL(10,2) NOT NULL DEFAULT 0.00,
        payment_mode ENUM('Cash', 'UPI', 'Card') NOT NULL DEFAULT 'Cash',
        payment_status ENUM('PENDING', 'PAID', 'FAILED') NOT NULL DEFAULT 'PAID',
        payment_reference VARCHAR(120) DEFAULT NULL,
        billing_counter VARCHAR(20) NOT NULL DEFAULT 'Counter 1',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        transaction_type ENUM('B2C', 'B2B') NOT NULL DEFAULT 'B2C',
        billing_tier ENUM('RETAIL', 'WHOLESALE') NOT NULL DEFAULT 'RETAIL',
        tax_type ENUM('LOCAL', 'INTERSTATE') NOT NULL DEFAULT 'LOCAL',
        customer_company_name VARCHAR(255) DEFAULT NULL,
        customer_gstin VARCHAR(15) DEFAULT NULL,
        total_cgst DECIMAL(10,2) NOT NULL DEFAULT 0.00,
        total_sgst DECIMAL(10,2) NOT NULL DEFAULT 0.00,
        total_igst DECIMAL(10,2) NOT NULL DEFAULT 0.00,
        invoice_status VARCHAR(20) NOT NULL DEFAULT 'PAID',
        cancel_reason VARCHAR(255) DEFAULT NULL,
        cancelled_by VARCHAR(100) DEFAULT NULL,
        cancelled_at TIMESTAMP NULL DEFAULT NULL,
        reprint_count INT NOT NULL DEFAULT 0,
        INDEX idx_invoice_no (invoice_no),
        INDEX idx_created_at (created_at),
        INDEX idx_invoice_status (invoice_status)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    `);

    await connection.query(`
      CREATE TABLE IF NOT EXISTS invoice_items (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        invoice_no VARCHAR(50) NOT NULL,
        barcode VARCHAR(120) NOT NULL,
        product_name VARCHAR(255) NOT NULL,
        quantity DECIMAL(10,2) NOT NULL DEFAULT 1.00,
        sale_price DECIMAL(10,2) NOT NULL DEFAULT 0.00,
        gst_percent DECIMAL(5,2) NOT NULL DEFAULT 0.00,
        cgst_amount DECIMAL(10,2) NOT NULL DEFAULT 0.00,
        sgst_amount DECIMAL(10,2) NOT NULL DEFAULT 0.00,
        igst_amount DECIMAL(10,2) NOT NULL DEFAULT 0.00,
        returned_qty DECIMAL(10,2) NOT NULL DEFAULT 0.00,
        FOREIGN KEY (invoice_no) REFERENCES invoices(invoice_no) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    `);

    await connection.query(`
      CREATE TABLE IF NOT EXISTS held_bills (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        hold_token VARCHAR(80) NOT NULL UNIQUE,
        counter_no INT NOT NULL DEFAULT 1,
        customer_name VARCHAR(150) DEFAULT 'Walk-in Customer',
        customer_phone VARCHAR(20) DEFAULT '',
        bill_total DECIMAL(10,2) NOT NULL DEFAULT 0.00,
        item_count INT NOT NULL DEFAULT 0,
        saved_state JSON NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX idx_hold_counter (counter_no),
        INDEX idx_hold_updated_at (updated_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    `);

    await connection.query(`
      CREATE TABLE IF NOT EXISTS invoice_sequences (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        financial_year VARCHAR(7) NOT NULL,
        counter_no TINYINT NOT NULL,
        next_number BIGINT NOT NULL DEFAULT 1,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY uniq_invoice_sequence (financial_year, counter_no)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    `);

    await connection.query(`
      CREATE TABLE IF NOT EXISTS app_settings (
        setting_key VARCHAR(100) PRIMARY KEY,
        setting_value VARCHAR(255) NOT NULL,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    `);

    await connection.query(`
      CREATE TABLE IF NOT EXISTS inward_entries (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        inward_no VARCHAR(50) NOT NULL UNIQUE,
        supplier_name VARCHAR(255) NOT NULL,
        supplier_address VARCHAR(255) DEFAULT '',
        supplier_gstin VARCHAR(20) DEFAULT '',
        supplier_phone VARCHAR(20) DEFAULT '',
        supplier_invoice_no VARCHAR(100) DEFAULT '',
        supplier_invoice_date DATE DEFAULT NULL,
        item_count INT NOT NULL DEFAULT 0,
        total_qty DECIMAL(12,2) NOT NULL DEFAULT 0.00,
        taxable_total DECIMAL(12,2) NOT NULL DEFAULT 0.00,
        gst_total DECIMAL(12,2) NOT NULL DEFAULT 0.00,
        total_cgst DECIMAL(12,2) NOT NULL DEFAULT 0.00,
        total_sgst DECIMAL(12,2) NOT NULL DEFAULT 0.00,
        total_igst DECIMAL(12,2) NOT NULL DEFAULT 0.00,
        grand_total DECIMAL(12,2) NOT NULL DEFAULT 0.00,
        tax_type ENUM('LOCAL', 'INTERSTATE') NOT NULL DEFAULT 'LOCAL',
        created_by VARCHAR(100) DEFAULT '',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_inward_created_at (created_at),
        INDEX idx_supplier_invoice_no (supplier_invoice_no)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    `);

    await connection.query(`
      CREATE TABLE IF NOT EXISTS inward_items (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        inward_no VARCHAR(50) NOT NULL,
        barcode VARCHAR(120) NOT NULL,
        product_name VARCHAR(255) NOT NULL,
        hsn_code VARCHAR(20) DEFAULT '',
        gst_percent DECIMAL(5,2) NOT NULL DEFAULT 0.00,
        purchase_price DECIMAL(10,2) NOT NULL DEFAULT 0.00,
        discount_percent DECIMAL(10,2) NOT NULL DEFAULT 0.00,
        discount_type ENUM('PERCENT', 'VALUE') NOT NULL DEFAULT 'PERCENT',
        discount_amount DECIMAL(12,2) NOT NULL DEFAULT 0.00,
        scheme VARCHAR(100) DEFAULT '',
        scheme_type ENUM('PERCENT', 'VALUE') NOT NULL DEFAULT 'PERCENT',
        scheme_value DECIMAL(12,2) NOT NULL DEFAULT 0.00,
        scheme_amount DECIMAL(12,2) NOT NULL DEFAULT 0.00,
        free_qty DECIMAL(12,2) NOT NULL DEFAULT 0.00,
        mrp DECIMAL(10,2) NOT NULL DEFAULT 0.00,
        quantity DECIMAL(12,2) NOT NULL DEFAULT 0.00,
        taxable_amount DECIMAL(12,2) NOT NULL DEFAULT 0.00,
        gst_amount DECIMAL(12,2) NOT NULL DEFAULT 0.00,
        cgst_amount DECIMAL(12,2) NOT NULL DEFAULT 0.00,
        sgst_amount DECIMAL(12,2) NOT NULL DEFAULT 0.00,
        igst_amount DECIMAL(12,2) NOT NULL DEFAULT 0.00,
        total_amount DECIMAL(12,2) NOT NULL DEFAULT 0.00,
        FOREIGN KEY (inward_no) REFERENCES inward_entries(inward_no) ON DELETE CASCADE,
        INDEX idx_inward_items_barcode (barcode)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    `);

    await connection.query(`
      CREATE TABLE IF NOT EXISTS audit_logs (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        user_id BIGINT DEFAULT NULL,
        username VARCHAR(100) DEFAULT 'system',
        role VARCHAR(30) DEFAULT 'SYSTEM',
        action VARCHAR(80) NOT NULL,
        entity_type VARCHAR(80) NOT NULL,
        entity_id VARCHAR(120) DEFAULT NULL,
        details JSON DEFAULT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_audit_created_at (created_at),
        INDEX idx_audit_entity (entity_type, entity_id),
        INDEX idx_audit_user (username)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    `);

    await connection.query(`
      CREATE TABLE IF NOT EXISTS sales_returns (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        return_no VARCHAR(60) NOT NULL UNIQUE,
        invoice_no VARCHAR(50) NOT NULL,
        reason VARCHAR(255) NOT NULL,
        refund_mode ENUM('Cash', 'UPI', 'Card', 'Store Credit') NOT NULL DEFAULT 'Cash',
        taxable_total DECIMAL(12,2) NOT NULL DEFAULT 0.00,
        gst_total DECIMAL(12,2) NOT NULL DEFAULT 0.00,
        refund_total DECIMAL(12,2) NOT NULL DEFAULT 0.00,
        created_by VARCHAR(100) DEFAULT '',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_return_invoice (invoice_no),
        INDEX idx_return_created_at (created_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    `);

    await connection.query(`
      CREATE TABLE IF NOT EXISTS sales_return_items (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        return_no VARCHAR(60) NOT NULL,
        invoice_item_id BIGINT NOT NULL,
        barcode VARCHAR(120) NOT NULL,
        product_name VARCHAR(255) NOT NULL,
        quantity DECIMAL(10,2) NOT NULL DEFAULT 0.00,
        sale_price DECIMAL(10,2) NOT NULL DEFAULT 0.00,
        gst_percent DECIMAL(5,2) NOT NULL DEFAULT 0.00,
        taxable_amount DECIMAL(12,2) NOT NULL DEFAULT 0.00,
        gst_amount DECIMAL(12,2) NOT NULL DEFAULT 0.00,
        refund_amount DECIMAL(12,2) NOT NULL DEFAULT 0.00,
        FOREIGN KEY (return_no) REFERENCES sales_returns(return_no) ON DELETE CASCADE,
        INDEX idx_return_item_barcode (barcode)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    `);

    await connection.query(`
      CREATE TABLE IF NOT EXISTS customers (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        customer_name VARCHAR(150) NOT NULL DEFAULT 'Walk-in Customer',
        phone VARCHAR(20) NOT NULL UNIQUE,
        gstin VARCHAR(20) DEFAULT '',
        address VARCHAR(255) DEFAULT '',
        loyalty_points DECIMAL(12,2) NOT NULL DEFAULT 0.00,
        total_spent DECIMAL(12,2) NOT NULL DEFAULT 0.00,
        visit_count INT NOT NULL DEFAULT 0,
        last_visit_at TIMESTAMP NULL DEFAULT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX idx_customer_phone (phone)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    `);

    await connection.query(`
      CREATE TABLE IF NOT EXISTS loyalty_transactions (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        customer_id BIGINT NOT NULL,
        invoice_no VARCHAR(50) DEFAULT NULL,
        points_delta DECIMAL(12,2) NOT NULL DEFAULT 0.00,
        transaction_type ENUM('EARN', 'REDEEM', 'ADJUST') NOT NULL DEFAULT 'EARN',
        note VARCHAR(255) DEFAULT '',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_loyalty_customer (customer_id),
        INDEX idx_loyalty_invoice (invoice_no)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    `);

    await connection.query(`
      CREATE TABLE IF NOT EXISTS counter_closings (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        closing_date DATE NOT NULL,
        counter_no INT NOT NULL,
        opening_cash DECIMAL(12,2) NOT NULL DEFAULT 0.00,
        expected_cash_sales DECIMAL(12,2) NOT NULL DEFAULT 0.00,
        expected_upi_sales DECIMAL(12,2) NOT NULL DEFAULT 0.00,
        expected_card_sales DECIMAL(12,2) NOT NULL DEFAULT 0.00,
        cash_in_total DECIMAL(12,2) NOT NULL DEFAULT 0.00,
        cash_out_total DECIMAL(12,2) NOT NULL DEFAULT 0.00,
        declared_cash_total DECIMAL(12,2) NOT NULL DEFAULT 0.00,
        expected_cash_in_hand DECIMAL(12,2) NOT NULL DEFAULT 0.00,
        difference_amount DECIMAL(12,2) NOT NULL DEFAULT 0.00,
        denominations_json JSON NOT NULL,
        movements_json JSON NOT NULL,
        handed_over_by VARCHAR(120) NOT NULL,
        taken_over_by VARCHAR(120) NOT NULL,
        notes VARCHAR(255) DEFAULT '',
        created_by VARCHAR(100) DEFAULT '',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY uniq_counter_closing (closing_date, counter_no),
        INDEX idx_counter_closing_date (closing_date)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    `);

    await connection.query(`
      INSERT IGNORE INTO app_settings (setting_key, setting_value)
      VALUES
        ('shop_name', 'Hyper Fresh Mart LLP'),
        ('gst_number', '36AAJFH7790R1ZB'),
        ('phone', '08761 295000'),
        ('address', 'Sathupally - Khammam(dt) - 507303'),
        ('counter_count', '6'),
        ('default_print_mode', 'Thermal')
    `);

    await ensureColumn(connection, 'products', 'purchase_price', 'DECIMAL(10,2) NOT NULL DEFAULT 0.00 AFTER mrp');
    await ensureColumn(connection, 'products', 'wholesale_price', 'DECIMAL(10,2) NOT NULL DEFAULT 0.00 AFTER sale_price');
    await ensureColumn(connection, 'products', 'product_code', 'VARCHAR(60) DEFAULT NULL UNIQUE AFTER id');
    await ensureColumn(connection, 'products', 'unit_type', "VARCHAR(20) NOT NULL DEFAULT 'Nos' AFTER gst_percent");
    await ensureColumn(connection, 'products', 'discount_type', "ENUM('PERCENT', 'VALUE') NOT NULL DEFAULT 'PERCENT' AFTER wholesale_price");
    await ensureColumn(connection, 'products', 'discount_value', 'DECIMAL(10,2) NOT NULL DEFAULT 0.00 AFTER discount_type');
    await ensureColumn(connection, 'products', 'bulk_discount_value', 'DECIMAL(10,2) NOT NULL DEFAULT 0.00 AFTER discount_value');
    await ensureColumn(connection, 'products', 'is_free_item', 'TINYINT(1) NOT NULL DEFAULT 0 AFTER bulk_discount_value');
    await ensureColumn(connection, 'products', 'min_stock_alert', 'DECIMAL(10,2) NOT NULL DEFAULT 10.00 AFTER stock_qty');
    await ensureColumn(connection, 'invoices', 'transaction_type', "ENUM('B2C', 'B2B') NOT NULL DEFAULT 'B2C' AFTER created_at");
    await ensureColumn(connection, 'invoices', 'payment_status', "ENUM('PENDING', 'PAID', 'FAILED') NOT NULL DEFAULT 'PAID' AFTER payment_mode");
    await ensureColumn(connection, 'invoices', 'payment_reference', 'VARCHAR(120) DEFAULT NULL AFTER payment_status');
    await ensureColumn(connection, 'invoices', 'customer_address', 'VARCHAR(255) DEFAULT NULL AFTER customer_name');
    await ensureColumn(connection, 'invoices', 'billing_tier', "ENUM('RETAIL', 'WHOLESALE') NOT NULL DEFAULT 'RETAIL' AFTER transaction_type");
    await ensureColumn(connection, 'invoices', 'tax_type', "ENUM('LOCAL', 'INTERSTATE') NOT NULL DEFAULT 'LOCAL' AFTER billing_tier");
    await ensureColumn(connection, 'invoices', 'customer_company_name', 'VARCHAR(255) DEFAULT NULL AFTER tax_type');
    await ensureColumn(connection, 'invoices', 'customer_gstin', 'VARCHAR(15) DEFAULT NULL AFTER customer_company_name');
    await ensureColumn(connection, 'invoices', 'total_cgst', 'DECIMAL(10,2) NOT NULL DEFAULT 0.00 AFTER customer_gstin');
    await ensureColumn(connection, 'invoices', 'total_sgst', 'DECIMAL(10,2) NOT NULL DEFAULT 0.00 AFTER total_cgst');
    await ensureColumn(connection, 'invoices', 'total_igst', 'DECIMAL(10,2) NOT NULL DEFAULT 0.00 AFTER total_sgst');
    await ensureColumn(connection, 'invoices', 'invoice_status', "VARCHAR(20) NOT NULL DEFAULT 'PAID' AFTER total_igst");
    await ensureColumn(connection, 'invoices', 'cancel_reason', 'VARCHAR(255) DEFAULT NULL AFTER invoice_status');
    await ensureColumn(connection, 'invoices', 'cancelled_by', 'VARCHAR(100) DEFAULT NULL AFTER cancel_reason');
    await ensureColumn(connection, 'invoices', 'cancelled_at', 'TIMESTAMP NULL DEFAULT NULL AFTER cancelled_by');
    await ensureColumn(connection, 'invoices', 'reprint_count', 'INT NOT NULL DEFAULT 0 AFTER cancelled_at');
    await ensureColumn(connection, 'invoice_items', 'cgst_amount', 'DECIMAL(10,2) NOT NULL DEFAULT 0.00 AFTER gst_percent');
    await ensureColumn(connection, 'invoice_items', 'sgst_amount', 'DECIMAL(10,2) NOT NULL DEFAULT 0.00 AFTER cgst_amount');
    await ensureColumn(connection, 'invoice_items', 'igst_amount', 'DECIMAL(10,2) NOT NULL DEFAULT 0.00 AFTER sgst_amount');
    await ensureColumn(connection, 'invoice_items', 'returned_qty', 'DECIMAL(10,2) NOT NULL DEFAULT 0.00 AFTER igst_amount');
    await ensureColumn(connection, 'inward_entries', 'total_cgst', 'DECIMAL(12,2) NOT NULL DEFAULT 0.00 AFTER gst_total');
    await ensureColumn(connection, 'inward_entries', 'total_sgst', 'DECIMAL(12,2) NOT NULL DEFAULT 0.00 AFTER total_cgst');
    await ensureColumn(connection, 'inward_entries', 'total_igst', 'DECIMAL(12,2) NOT NULL DEFAULT 0.00 AFTER total_sgst');
    await ensureColumn(connection, 'inward_entries', 'tax_type', "ENUM('LOCAL', 'INTERSTATE') NOT NULL DEFAULT 'LOCAL' AFTER grand_total");
    await ensureColumn(connection, 'inward_items', 'discount_type', "ENUM('PERCENT', 'VALUE') NOT NULL DEFAULT 'PERCENT' AFTER discount_percent");
    await ensureColumn(connection, 'inward_items', 'discount_amount', 'DECIMAL(12,2) NOT NULL DEFAULT 0.00 AFTER discount_type');
    await ensureColumn(connection, 'inward_items', 'scheme_type', "ENUM('PERCENT', 'VALUE') NOT NULL DEFAULT 'PERCENT' AFTER scheme");
    await ensureColumn(connection, 'inward_items', 'scheme_value', 'DECIMAL(12,2) NOT NULL DEFAULT 0.00 AFTER scheme_type');
    await ensureColumn(connection, 'inward_items', 'scheme_amount', 'DECIMAL(12,2) NOT NULL DEFAULT 0.00 AFTER scheme_value');
    await ensureColumn(connection, 'inward_items', 'mrp', 'DECIMAL(10,2) NOT NULL DEFAULT 0.00 AFTER scheme');
    await ensureColumn(connection, 'inward_items', 'free_qty', 'DECIMAL(12,2) NOT NULL DEFAULT 0.00 AFTER mrp');
    await ensureColumn(connection, 'inward_items', 'cgst_amount', 'DECIMAL(12,2) NOT NULL DEFAULT 0.00 AFTER gst_amount');
    await ensureColumn(connection, 'inward_items', 'sgst_amount', 'DECIMAL(12,2) NOT NULL DEFAULT 0.00 AFTER cgst_amount');
    await ensureColumn(connection, 'inward_items', 'igst_amount', 'DECIMAL(12,2) NOT NULL DEFAULT 0.00 AFTER sgst_amount');
    await ensureColumn(connection, 'held_bills', 'counter_no', 'INT NOT NULL DEFAULT 1 AFTER hold_token');
    await ensureColumn(connection, 'held_bills', 'customer_name', "VARCHAR(150) DEFAULT 'Walk-in Customer' AFTER counter_no");
    await ensureColumn(connection, 'held_bills', 'customer_phone', "VARCHAR(20) DEFAULT '' AFTER customer_name");
    await ensureColumn(connection, 'held_bills', 'bill_total', 'DECIMAL(10,2) NOT NULL DEFAULT 0.00 AFTER customer_phone');
    await ensureColumn(connection, 'held_bills', 'item_count', 'INT NOT NULL DEFAULT 0 AFTER bill_total');
    await ensureColumn(connection, 'held_bills', 'updated_at', 'TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP AFTER created_at');
    await ensureColumn(connection, 'users', 'password_hash', 'VARCHAR(255) NOT NULL AFTER username');
    await ensureColumn(connection, 'users', 'role', "ENUM('SERVER', 'ADMIN', 'COUNTER') NOT NULL DEFAULT 'COUNTER' AFTER password_hash");
    await ensureColumn(connection, 'users', 'counter_no', 'INT DEFAULT NULL AFTER role');
    await ensureColumn(connection, 'users', 'is_active', 'TINYINT(1) NOT NULL DEFAULT 1 AFTER counter_no');

    await connection.query(`
      UPDATE products
      SET purchase_price = wholesale_price
      WHERE purchase_price = 0 AND wholesale_price > 0
    `);

    const defaultUsers = [
      ['server', 'server123', 'SERVER', null],
      ['admin', 'admin123', 'ADMIN', null],
      ['counter1', 'counter123', 'COUNTER', 1]
    ];

    for (const [username, password, role, counterNo] of defaultUsers) {
      await connection.query(
        `INSERT IGNORE INTO users (username, password_hash, role, counter_no)
         VALUES (?, ?, ?, ?)`,
        [username, hashPassword(password), role, counterNo]
      );
    }

    console.log('Database schema is ready.');
  } catch (err) {
    console.error('Database initialization failed:', err.message);
  } finally {
    if (connection) connection.release();
  }
})();

module.exports = pool;
