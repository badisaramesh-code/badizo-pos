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
        alias_names TEXT DEFAULT NULL,
        hsn_code VARCHAR(20) DEFAULT NULL,
        gst_percent DECIMAL(5,2) NOT NULL DEFAULT 0.00,
        unit_type VARCHAR(20) NOT NULL DEFAULT 'Nos',
        purchase_unit_type VARCHAR(30) NOT NULL DEFAULT 'Loose',
        purchase_unit_size DECIMAL(12,3) NOT NULL DEFAULT 1.000,
        mrp DECIMAL(10,2) NOT NULL DEFAULT 0.00,
        purchase_price DECIMAL(10,2) NOT NULL DEFAULT 0.00,
        sale_price DECIMAL(10,2) NOT NULL DEFAULT 0.00,
        wholesale_price DECIMAL(10,2) NOT NULL DEFAULT 0.00,
        discount_type ENUM('PERCENT', 'VALUE') NOT NULL DEFAULT 'PERCENT',
        discount_value DECIMAL(10,2) NOT NULL DEFAULT 0.00,
        bulk_discount_value DECIMAL(10,2) NOT NULL DEFAULT 0.00,
        is_free_item TINYINT(1) NOT NULL DEFAULT 0,
        free_promo_enabled TINYINT(1) NOT NULL DEFAULT 0,
        free_promo_name VARCHAR(255) DEFAULT '',
        free_promo_qty_per_sale DECIMAL(12,3) NOT NULL DEFAULT 1.000,
        free_promo_total_qty DECIMAL(12,2) NOT NULL DEFAULT 0.00,
        free_promo_remaining_qty DECIMAL(12,2) NOT NULL DEFAULT 0.00,
        stock_qty DECIMAL(10,2) NOT NULL DEFAULT 0.00,
        min_stock_alert DECIMAL(10,2) NOT NULL DEFAULT 10.00,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
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
        payment_mode ENUM('Cash', 'UPI', 'Card', 'Mixed') NOT NULL DEFAULT 'Cash',
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
        exchange_total DECIMAL(10,2) NOT NULL DEFAULT 0.00,
        exchange_items_json JSON DEFAULT NULL,
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
        is_free_bonus TINYINT(1) NOT NULL DEFAULT 0,
        free_offer_id BIGINT DEFAULT NULL,
        returned_qty DECIMAL(10,2) NOT NULL DEFAULT 0.00,
        FOREIGN KEY (invoice_no) REFERENCES invoices(invoice_no) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    `);

    await connection.query(`
      CREATE TABLE IF NOT EXISTS product_batches (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        barcode VARCHAR(120) NOT NULL,
        batch_no VARCHAR(80) NOT NULL DEFAULT '',
        expiry_date DATE DEFAULT NULL,
        inward_no VARCHAR(50) DEFAULT NULL,
        purchase_price DECIMAL(10,2) NOT NULL DEFAULT 0.00,
        mrp DECIMAL(10,2) NOT NULL DEFAULT 0.00,
        quantity_received DECIMAL(12,2) NOT NULL DEFAULT 0.00,
        quantity_available DECIMAL(12,2) NOT NULL DEFAULT 0.00,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY uniq_product_batch (barcode, batch_no, expiry_date),
        INDEX idx_product_batch_barcode (barcode),
        INDEX idx_product_batch_expiry (expiry_date)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    `);

    await connection.query(`
      CREATE TABLE IF NOT EXISTS barcode_print_logs (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        barcode VARCHAR(120) NOT NULL,
        product_name VARCHAR(255) NOT NULL,
        mrp DECIMAL(10,2) NOT NULL DEFAULT 0.00,
        sale_price DECIMAL(10,2) NOT NULL DEFAULT 0.00,
        pkd_date VARCHAR(20) DEFAULT '',
        qty VARCHAR(20) DEFAULT '',
        unit VARCHAR(20) DEFAULT '',
        template_name VARCHAR(120) NOT NULL,
        sticker_size VARCHAR(80) DEFAULT '',
        printer_name VARCHAR(120) DEFAULT '',
        sticker_count INT NOT NULL DEFAULT 1,
        output_name VARCHAR(255) DEFAULT '',
        output_path VARCHAR(500) DEFAULT '',
        created_by VARCHAR(100) DEFAULT '',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_barcode_print_created_at (created_at),
        INDEX idx_barcode_print_barcode (barcode),
        INDEX idx_barcode_print_product (product_name)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    `);

    await connection.query(`
      CREATE TABLE IF NOT EXISTS password_vault (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        category VARCHAR(40) NOT NULL DEFAULT 'STORE_PROTECTED',
        slot_no TINYINT NOT NULL UNIQUE,
        title VARCHAR(120) NOT NULL DEFAULT '',
        username VARCHAR(120) DEFAULT '',
        secret_encrypted TEXT DEFAULT NULL,
        notes VARCHAR(255) DEFAULT '',
        updated_by VARCHAR(100) DEFAULT '',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX idx_password_vault_slot (slot_no),
        INDEX idx_password_vault_category (category)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    `);

    await connection.query(`
      CREATE TABLE IF NOT EXISTS invoice_item_batches (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        invoice_item_id BIGINT NOT NULL,
        invoice_no VARCHAR(50) NOT NULL,
        barcode VARCHAR(120) NOT NULL,
        batch_no VARCHAR(80) NOT NULL DEFAULT '',
        expiry_date DATE DEFAULT NULL,
        quantity DECIMAL(12,2) NOT NULL DEFAULT 0.00,
        returned_qty DECIMAL(12,2) NOT NULL DEFAULT 0.00,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_invoice_item_batches_invoice (invoice_no),
        INDEX idx_invoice_item_batches_item (invoice_item_id),
        INDEX idx_invoice_item_batches_barcode (barcode),
        FOREIGN KEY (invoice_item_id) REFERENCES invoice_items(id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    `);

    await connection.query(`
      CREATE TABLE IF NOT EXISTS batch_free_offers (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        trigger_barcode VARCHAR(120) NOT NULL,
        trigger_batch_no VARCHAR(80) NOT NULL DEFAULT '',
        trigger_expiry_date DATE DEFAULT NULL,
        inward_no VARCHAR(50) DEFAULT NULL,
        free_barcode VARCHAR(120) NOT NULL,
        free_product_name VARCHAR(255) NOT NULL,
        free_qty_per_sale DECIMAL(12,3) NOT NULL DEFAULT 1.000,
        free_qty_total DECIMAL(12,2) NOT NULL DEFAULT 0.00,
        free_qty_remaining DECIMAL(12,2) NOT NULL DEFAULT 0.00,
        is_active TINYINT(1) NOT NULL DEFAULT 1,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY uniq_batch_free_offer (trigger_barcode, trigger_batch_no, trigger_expiry_date, free_barcode),
        INDEX idx_batch_free_trigger (trigger_barcode, trigger_batch_no),
        INDEX idx_batch_free_item (free_barcode),
        INDEX idx_batch_free_active (is_active, free_qty_remaining)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    `);

    await connection.query(`
      CREATE TABLE IF NOT EXISTS invoice_payments (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        invoice_no VARCHAR(50) NOT NULL,
        payment_mode ENUM('Cash', 'UPI', 'Card') NOT NULL,
        amount DECIMAL(10,2) NOT NULL DEFAULT 0.00,
        payment_reference VARCHAR(120) DEFAULT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_invoice_payments_invoice (invoice_no),
        INDEX idx_invoice_payments_mode (payment_mode),
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
        payment_mode ENUM('Credit', 'Cash') NOT NULL DEFAULT 'Credit',
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
        batch_no VARCHAR(80) DEFAULT '',
        expiry_date DATE DEFAULT NULL,
        free_qty DECIMAL(12,2) NOT NULL DEFAULT 0.00,
        free_offer_enabled TINYINT(1) NOT NULL DEFAULT 0,
        free_offer_barcode VARCHAR(120) DEFAULT '',
        free_offer_product_name VARCHAR(255) DEFAULT '',
        free_offer_qty_per_sale DECIMAL(12,3) NOT NULL DEFAULT 1.000,
        free_offer_total_qty DECIMAL(12,2) NOT NULL DEFAULT 0.00,
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
      CREATE TABLE IF NOT EXISTS counter_handover_sheets (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        closing_date DATE NOT NULL,
        counter_no INT NOT NULL,
        sheet_no VARCHAR(80) NOT NULL UNIQUE,
        opening_cash DECIMAL(12,2) NOT NULL DEFAULT 0.00,
        counter_sales DECIMAL(12,2) NOT NULL DEFAULT 0.00,
        all_counter_sales DECIMAL(12,2) NOT NULL DEFAULT 0.00,
        cash_sales DECIMAL(12,2) NOT NULL DEFAULT 0.00,
        upi_sales DECIMAL(12,2) NOT NULL DEFAULT 0.00,
        card_sales DECIMAL(12,2) NOT NULL DEFAULT 0.00,
        dr_total DECIMAL(12,2) NOT NULL DEFAULT 0.00,
        cr_total DECIMAL(12,2) NOT NULL DEFAULT 0.00,
        notes_total DECIMAL(12,2) NOT NULL DEFAULT 0.00,
        cash_balance DECIMAL(12,2) NOT NULL DEFAULT 0.00,
        variance_amount DECIMAL(12,2) NOT NULL DEFAULT 0.00,
        handed_over_by VARCHAR(120) DEFAULT '',
        taken_over_by VARCHAR(120) DEFAULT '',
        notes VARCHAR(255) DEFAULT '',
        created_by VARCHAR(100) DEFAULT '',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY uniq_counter_handover (closing_date, counter_no),
        INDEX idx_counter_handover_date (closing_date),
        INDEX idx_counter_handover_counter (counter_no)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    `);

    await connection.query(`
      CREATE TABLE IF NOT EXISTS counter_handover_entries (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        sheet_id BIGINT NOT NULL,
        line_no INT NOT NULL,
        entry_type VARCHAR(40) DEFAULT 'GENERAL',
        details VARCHAR(180) NOT NULL,
        remarks VARCHAR(255) DEFAULT '',
        direction ENUM('DR', 'CR') NOT NULL,
        amount DECIMAL(12,2) NOT NULL DEFAULT 0.00,
        FOREIGN KEY (sheet_id) REFERENCES counter_handover_sheets(id) ON DELETE CASCADE,
        INDEX idx_handover_entry_sheet (sheet_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    `);

    await connection.query(`
      CREATE TABLE IF NOT EXISTS counter_handover_denominations (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        sheet_id BIGINT NOT NULL,
        denomination_label VARCHAR(20) NOT NULL,
        denomination_value DECIMAL(10,2) NOT NULL DEFAULT 0.00,
        quantity DECIMAL(10,2) NOT NULL DEFAULT 0.00,
        amount DECIMAL(12,2) NOT NULL DEFAULT 0.00,
        FOREIGN KEY (sheet_id) REFERENCES counter_handover_sheets(id) ON DELETE CASCADE,
        INDEX idx_handover_denom_sheet (sheet_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    `);

    await connection.query(`
      CREATE TABLE IF NOT EXISTS accounting_vouchers (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        voucher_no VARCHAR(80) NOT NULL UNIQUE,
        voucher_date DATE NOT NULL,
        voucher_type ENUM('CREDITOR_PAYMENT', 'DEBTOR_RECEIPT') NOT NULL,
        account_name VARCHAR(180) NOT NULL,
        payment_mode ENUM('Cash', 'Bank') NOT NULL DEFAULT 'Cash',
        amount DECIMAL(12,2) NOT NULL DEFAULT 0.00,
        reference_no VARCHAR(120) DEFAULT '',
        remarks VARCHAR(255) DEFAULT '',
        created_by VARCHAR(100) DEFAULT '',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_accounting_voucher_date (voucher_date),
        INDEX idx_accounting_voucher_account (account_name),
        INDEX idx_accounting_voucher_type (voucher_type)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    `);

    await connection.query(`
      CREATE TABLE IF NOT EXISTS counter_cash_ledger_entries (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        entry_date DATE NOT NULL,
        counter_no INT DEFAULT NULL,
        source_type VARCHAR(40) NOT NULL DEFAULT 'MANUAL',
        source_id BIGINT DEFAULT NULL,
        account_name VARCHAR(160) NOT NULL,
        details VARCHAR(255) NOT NULL,
        direction ENUM('DR', 'CR') NOT NULL,
        amount DECIMAL(12,2) NOT NULL DEFAULT 0.00,
        payment_mode VARCHAR(30) DEFAULT '',
        created_by VARCHAR(100) DEFAULT '',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_cash_ledger_date (entry_date),
        INDEX idx_cash_ledger_source (source_type, source_id),
        INDEX idx_cash_ledger_account (account_name)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    `);

    await connection.query(`
      INSERT IGNORE INTO app_settings (setting_key, setting_value)
      VALUES
        ('shop_name', 'Hyper Fresh Mart LLP'),
        ('gst_number', '36AAJFH7790R1ZB'),
        ('phone', '08761 295000'),
        ('address', 'Sathupally - Khammam(dt) - 507303'),
        ('bank_name', 'HDFC BANK'),
        ('bank_account_name', 'Hyper Fresh Mart LLP'),
        ('bank_account_no', '59209440987345'),
        ('bank_ifsc', 'HDFC0004047'),
        ('bank_branch', 'Sathupally'),
        ('counter_count', '6'),
        ('default_print_mode', 'Thermal')
    `);

    await ensureColumn(connection, 'products', 'purchase_price', 'DECIMAL(10,2) NOT NULL DEFAULT 0.00 AFTER mrp');
    await ensureColumn(connection, 'products', 'wholesale_price', 'DECIMAL(10,2) NOT NULL DEFAULT 0.00 AFTER sale_price');
    await ensureColumn(connection, 'products', 'product_code', 'VARCHAR(60) DEFAULT NULL UNIQUE AFTER id');
    await ensureColumn(connection, 'products', 'alias_names', 'TEXT DEFAULT NULL AFTER product_name');
    await ensureColumn(connection, 'products', 'unit_type', "VARCHAR(20) NOT NULL DEFAULT 'Nos' AFTER gst_percent");
    await ensureColumn(connection, 'products', 'purchase_unit_type', "VARCHAR(30) NOT NULL DEFAULT 'Loose' AFTER unit_type");
    await ensureColumn(connection, 'products', 'purchase_unit_size', 'DECIMAL(12,3) NOT NULL DEFAULT 1.000 AFTER purchase_unit_type');
    await ensureColumn(connection, 'products', 'discount_type', "ENUM('PERCENT', 'VALUE') NOT NULL DEFAULT 'PERCENT' AFTER wholesale_price");
    await ensureColumn(connection, 'products', 'discount_value', 'DECIMAL(10,2) NOT NULL DEFAULT 0.00 AFTER discount_type');
    await ensureColumn(connection, 'products', 'bulk_discount_value', 'DECIMAL(10,2) NOT NULL DEFAULT 0.00 AFTER discount_value');
    await ensureColumn(connection, 'products', 'is_free_item', 'TINYINT(1) NOT NULL DEFAULT 0 AFTER bulk_discount_value');
    await ensureColumn(connection, 'products', 'free_promo_enabled', 'TINYINT(1) NOT NULL DEFAULT 0 AFTER is_free_item');
    await ensureColumn(connection, 'products', 'free_promo_name', "VARCHAR(255) DEFAULT '' AFTER free_promo_enabled");
    await ensureColumn(connection, 'products', 'free_promo_qty_per_sale', 'DECIMAL(12,3) NOT NULL DEFAULT 1.000 AFTER free_promo_name');
    await ensureColumn(connection, 'products', 'free_promo_total_qty', 'DECIMAL(12,2) NOT NULL DEFAULT 0.00 AFTER free_promo_qty_per_sale');
    await ensureColumn(connection, 'products', 'free_promo_remaining_qty', 'DECIMAL(12,2) NOT NULL DEFAULT 0.00 AFTER free_promo_total_qty');
    await ensureColumn(connection, 'products', 'min_stock_alert', 'DECIMAL(10,2) NOT NULL DEFAULT 10.00 AFTER stock_qty');
    await ensureColumn(connection, 'products', 'created_at', 'TIMESTAMP DEFAULT CURRENT_TIMESTAMP AFTER min_stock_alert');
    await ensureColumn(connection, 'products', 'updated_at', 'TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP AFTER created_at');
    await ensureColumn(connection, 'invoices', 'transaction_type', "ENUM('B2C', 'B2B') NOT NULL DEFAULT 'B2C' AFTER created_at");
    await connection.query("ALTER TABLE invoices MODIFY payment_mode ENUM('Cash', 'UPI', 'Card', 'Mixed') NOT NULL DEFAULT 'Cash'");
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
    await ensureColumn(connection, 'invoices', 'exchange_total', 'DECIMAL(10,2) NOT NULL DEFAULT 0.00 AFTER total_igst');
    await ensureColumn(connection, 'invoices', 'exchange_items_json', 'JSON DEFAULT NULL AFTER exchange_total');
    await ensureColumn(connection, 'invoices', 'invoice_status', "VARCHAR(20) NOT NULL DEFAULT 'PAID' AFTER exchange_items_json");
    await ensureColumn(connection, 'invoices', 'cancel_reason', 'VARCHAR(255) DEFAULT NULL AFTER invoice_status');
    await ensureColumn(connection, 'invoices', 'cancelled_by', 'VARCHAR(100) DEFAULT NULL AFTER cancel_reason');
    await ensureColumn(connection, 'invoices', 'cancelled_at', 'TIMESTAMP NULL DEFAULT NULL AFTER cancelled_by');
    await ensureColumn(connection, 'invoices', 'reprint_count', 'INT NOT NULL DEFAULT 0 AFTER cancelled_at');
    await ensureColumn(connection, 'invoice_items', 'cgst_amount', 'DECIMAL(10,2) NOT NULL DEFAULT 0.00 AFTER gst_percent');
    await ensureColumn(connection, 'invoice_items', 'sgst_amount', 'DECIMAL(10,2) NOT NULL DEFAULT 0.00 AFTER cgst_amount');
    await ensureColumn(connection, 'invoice_items', 'igst_amount', 'DECIMAL(10,2) NOT NULL DEFAULT 0.00 AFTER sgst_amount');
    await ensureColumn(connection, 'invoice_items', 'is_free_bonus', 'TINYINT(1) NOT NULL DEFAULT 0 AFTER igst_amount');
    await ensureColumn(connection, 'invoice_items', 'free_offer_id', 'BIGINT DEFAULT NULL AFTER is_free_bonus');
    await ensureColumn(connection, 'invoice_items', 'returned_qty', 'DECIMAL(10,2) NOT NULL DEFAULT 0.00 AFTER igst_amount');
    await ensureColumn(connection, 'invoice_item_batches', 'returned_qty', 'DECIMAL(12,2) NOT NULL DEFAULT 0.00 AFTER quantity');
    await ensureColumn(connection, 'batch_free_offers', 'free_qty_per_sale', 'DECIMAL(12,3) NOT NULL DEFAULT 1.000 AFTER free_product_name');
    await ensureColumn(connection, 'inward_entries', 'total_cgst', 'DECIMAL(12,2) NOT NULL DEFAULT 0.00 AFTER gst_total');
    await ensureColumn(connection, 'inward_entries', 'total_sgst', 'DECIMAL(12,2) NOT NULL DEFAULT 0.00 AFTER total_cgst');
    await ensureColumn(connection, 'inward_entries', 'total_igst', 'DECIMAL(12,2) NOT NULL DEFAULT 0.00 AFTER total_sgst');
    await ensureColumn(connection, 'inward_entries', 'tax_type', "ENUM('LOCAL', 'INTERSTATE') NOT NULL DEFAULT 'LOCAL' AFTER grand_total");
    await ensureColumn(connection, 'inward_entries', 'payment_mode', "ENUM('Credit', 'Cash') NOT NULL DEFAULT 'Credit' AFTER supplier_invoice_date");
    await ensureColumn(connection, 'inward_entries', 'posting_status', "ENUM('DRAFT', 'POSTED') NOT NULL DEFAULT 'POSTED' AFTER tax_type");
    await ensureColumn(connection, 'inward_items', 'discount_type', "ENUM('PERCENT', 'VALUE') NOT NULL DEFAULT 'PERCENT' AFTER discount_percent");
    await ensureColumn(connection, 'inward_items', 'discount_amount', 'DECIMAL(12,2) NOT NULL DEFAULT 0.00 AFTER discount_type');
    await ensureColumn(connection, 'inward_items', 'scheme_type', "ENUM('PERCENT', 'VALUE') NOT NULL DEFAULT 'PERCENT' AFTER scheme");
    await ensureColumn(connection, 'inward_items', 'scheme_value', 'DECIMAL(12,2) NOT NULL DEFAULT 0.00 AFTER scheme_type');
    await ensureColumn(connection, 'inward_items', 'scheme_amount', 'DECIMAL(12,2) NOT NULL DEFAULT 0.00 AFTER scheme_value');
    await ensureColumn(connection, 'inward_items', 'batch_no', "VARCHAR(80) DEFAULT '' AFTER scheme_amount");
    await ensureColumn(connection, 'inward_items', 'expiry_date', 'DATE DEFAULT NULL AFTER batch_no');
    await ensureColumn(connection, 'inward_items', 'mrp', 'DECIMAL(10,2) NOT NULL DEFAULT 0.00 AFTER scheme');
    await ensureColumn(connection, 'inward_items', 'free_qty', 'DECIMAL(12,2) NOT NULL DEFAULT 0.00 AFTER mrp');
    await ensureColumn(connection, 'inward_items', 'free_offer_enabled', 'TINYINT(1) NOT NULL DEFAULT 0 AFTER free_qty');
    await ensureColumn(connection, 'inward_items', 'free_offer_barcode', "VARCHAR(120) DEFAULT '' AFTER free_offer_enabled");
    await ensureColumn(connection, 'inward_items', 'free_offer_product_name', "VARCHAR(255) DEFAULT '' AFTER free_offer_barcode");
    await ensureColumn(connection, 'inward_items', 'free_offer_qty_per_sale', 'DECIMAL(12,3) NOT NULL DEFAULT 1.000 AFTER free_offer_product_name');
    await ensureColumn(connection, 'inward_items', 'free_offer_total_qty', 'DECIMAL(12,2) NOT NULL DEFAULT 0.00 AFTER free_offer_qty_per_sale');
    await ensureColumn(connection, 'inward_items', 'cgst_amount', 'DECIMAL(12,2) NOT NULL DEFAULT 0.00 AFTER gst_amount');
    await ensureColumn(connection, 'inward_items', 'sgst_amount', 'DECIMAL(12,2) NOT NULL DEFAULT 0.00 AFTER cgst_amount');
    await ensureColumn(connection, 'inward_items', 'igst_amount', 'DECIMAL(12,2) NOT NULL DEFAULT 0.00 AFTER sgst_amount');
    await ensureColumn(connection, 'held_bills', 'counter_no', 'INT NOT NULL DEFAULT 1 AFTER hold_token');
    await ensureColumn(connection, 'held_bills', 'customer_name', "VARCHAR(150) DEFAULT 'Walk-in Customer' AFTER counter_no");
    await ensureColumn(connection, 'held_bills', 'customer_phone', "VARCHAR(20) DEFAULT '' AFTER customer_name");
    await ensureColumn(connection, 'held_bills', 'bill_total', 'DECIMAL(10,2) NOT NULL DEFAULT 0.00 AFTER customer_phone');
    await ensureColumn(connection, 'held_bills', 'item_count', 'INT NOT NULL DEFAULT 0 AFTER bill_total');
    await ensureColumn(connection, 'held_bills', 'updated_at', 'TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP AFTER created_at');
    await ensureColumn(connection, 'password_vault', 'category', "VARCHAR(40) NOT NULL DEFAULT 'STORE_PROTECTED' AFTER id");
    await connection.query("UPDATE password_vault SET category = 'STORE_PROTECTED' WHERE category IS NULL OR category = ''");
    const [passwordVaultIndexes] = await connection.query(
      `SELECT INDEX_NAME
       FROM INFORMATION_SCHEMA.STATISTICS
       WHERE TABLE_SCHEMA = DATABASE()
         AND TABLE_NAME = 'password_vault'
         AND NON_UNIQUE = 0
         AND INDEX_NAME <> 'PRIMARY'
       GROUP BY INDEX_NAME
       HAVING GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX) = 'slot_no'`
    );
    for (const row of passwordVaultIndexes) {
      await connection.query(`ALTER TABLE password_vault DROP INDEX ${row.INDEX_NAME}`);
    }
    const [passwordVaultCategoryIndex] = await connection.query(
      `SELECT INDEX_NAME
       FROM INFORMATION_SCHEMA.STATISTICS
       WHERE TABLE_SCHEMA = DATABASE()
         AND TABLE_NAME = 'password_vault'
         AND INDEX_NAME = 'uniq_password_vault_category_slot'
       LIMIT 1`
    );
    if (passwordVaultCategoryIndex.length === 0) {
      await connection.query('ALTER TABLE password_vault ADD UNIQUE KEY uniq_password_vault_category_slot (category, slot_no)');
    }
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
