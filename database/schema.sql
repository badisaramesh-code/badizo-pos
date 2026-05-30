-- ==========================================================================
-- BADIZO ENTERPRISE POS DATABASE MIGRATION - ARCHITECT MASTER SCRIPT
-- ==========================================================================

SET FOREIGN_KEY_CHECKS = 0;
DROP DATABASE IF EXISTS badizo_pos;
SET FOREIGN_KEY_CHECKS = 1;

CREATE DATABASE badizo_pos CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
USE badizo_pos;

-- 1. Users Table (Identity Access Management)
CREATE TABLE users (
    id INT AUTO_INCREMENT PRIMARY KEY,
    username VARCHAR(100) NOT NULL UNIQUE,
    password VARCHAR(255) NOT NULL,
    role VARCHAR(50) NOT NULL DEFAULT 'Counter Staff',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB;

-- 2. Products Inventory Table (Upgraded with Wholesale Pricing Tiers)
CREATE TABLE products (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    barcode VARCHAR(120) NOT NULL UNIQUE,
    product_name VARCHAR(255) NOT NULL,
    hsn_code VARCHAR(20) DEFAULT NULL,
    gst_percent DECIMAL(5,2) NOT NULL DEFAULT 0.00,
    mrp DECIMAL(10,2) NOT NULL DEFAULT 0.00,
    sale_price DECIMAL(10,2) NOT NULL DEFAULT 0.00,      -- Retail Selling Price
    wholesale_price DECIMAL(10,2) NOT NULL DEFAULT 0.00, -- Wholesale Bulk Price
    stock_qty DECIMAL(10,2) NOT NULL DEFAULT 0.00,
    min_stock_alert DECIMAL(10,2) NOT NULL DEFAULT 10.00,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX idx_barcode (barcode),
    INDEX idx_product_name (product_name)
) ENGINE=InnoDB;

-- 3. Invoices (Billing Header Master Synced with Business Intelligence Metrics)
CREATE TABLE invoices (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    invoice_no VARCHAR(50) NOT NULL UNIQUE,
    customer_phone VARCHAR(15) DEFAULT NULL,
    customer_name VARCHAR(150) DEFAULT 'Walk-in Customer',
    sub_total DECIMAL(10,2) NOT NULL DEFAULT 0.00,
    gst_total DECIMAL(10,2) NOT NULL DEFAULT 0.00,
    grand_total DECIMAL(10,2) NOT NULL DEFAULT 0.00,
    cash_received DECIMAL(10,2) NOT NULL DEFAULT 0.00,
    change_returned DECIMAL(10,2) NOT NULL DEFAULT 0.00,
    payment_mode ENUM('Cash', 'UPI', 'Card') NOT NULL DEFAULT 'Cash',
    billing_counter VARCHAR(20) NOT NULL DEFAULT 'Counter 1',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    
    -- Enterprise Tax & Strategy Matrices Columns
    transaction_type ENUM('B2C', 'B2B') NOT NULL DEFAULT 'B2C',
    billing_tier ENUM('RETAIL', 'WHOLESALE') NOT NULL DEFAULT 'RETAIL',
    tax_type ENUM('LOCAL', 'INTERSTATE') NOT NULL DEFAULT 'LOCAL',
    customer_company_name VARCHAR(255) DEFAULT NULL,
    customer_gstin VARCHAR(15) DEFAULT NULL,
    total_cgst DECIMAL(10,2) NOT NULL DEFAULT 0.00,
    total_sgst DECIMAL(10,2) NOT NULL DEFAULT 0.00,
    total_igst DECIMAL(10,2) NOT NULL DEFAULT 0.00,

    INDEX idx_invoice_no (invoice_no),
    INDEX idx_created_at (created_at)
) ENGINE=InnoDB;

-- 4. Invoice Items (Billing Line Details Table Tracking Segmented Taxes)
CREATE TABLE invoice_items (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    invoice_no VARCHAR(50) NOT NULL,
    barcode VARCHAR(120) NOT NULL,
    product_name VARCHAR(255) NOT NULL,
    quantity DECIMAL(10,2) NOT NULL DEFAULT 1.00,
    sale_price DECIMAL(10,2) NOT NULL DEFAULT 0.00, -- Actual computed execution price (Retail or Wholesale)
    gst_percent DECIMAL(5,2) NOT NULL DEFAULT 0.00,
    cgst_amount DECIMAL(10,2) NOT NULL DEFAULT 0.00,
    sgst_amount DECIMAL(10,2) NOT NULL DEFAULT 0.00,
    igst_amount DECIMAL(10,2) NOT NULL DEFAULT 0.00,
    FOREIGN KEY (invoice_no) REFERENCES invoices(invoice_no) ON DELETE CASCADE
) ENGINE=InnoDB;

-- 5. Seed Initial High-Density Data for Production Testing
INSERT INTO users (username, password, role) VALUES 
('admin', '$2b$10$Eux/DMI/x1bUpE7nBv6H9e79ZfIeP8mUXZ2n7Cg', 'Admin');

-- Products catalog injected with balanced Retail vs Wholesale margin gaps
INSERT INTO products (barcode, product_name, hsn_code, gst_percent, mrp, sale_price, wholesale_price, stock_qty, min_stock_alert) VALUES
('8901058820013', 'Maggi Noodles 70g', '19023010', 18.00, 14.00, 14.00, 12.50, 500.00, 10.00),
('8901063105012', 'Amul Butter 100g', '04051000', 12.00, 56.00, 54.00, 49.00, 200.00, 15.00),
('8901801001108', 'Colgate Dental Cream 100g', '33061020', 18.00, 65.00, 62.00, 55.00, 150.00, 10.00),
('8901275012354', 'Parle G Biscuits', '19053110', 18.00, 10.00, 8.00, 7.00, 1000.00, 50.00),
('8901412015562', 'Tata Salt 1kg', '25010020', 0.00, 28.00, 27.00, 24.00, 400.00, 30.00);