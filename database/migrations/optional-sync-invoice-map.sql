-- Optional: install only alongside the validated receiving-side invoice handler.
-- Maps originating invoices/lines to receiver IDs; never infer identity from ID equality.
CREATE TABLE sync_invoice_map (
  shop_id VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  origin_installation_id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  source_invoice_no VARCHAR(50) NOT NULL,
  target_invoice_no VARCHAR(50) NOT NULL,
  checkout_payload LONGTEXT NOT NULL,
  PRIMARY KEY (shop_id, origin_installation_id, source_invoice_no),
  UNIQUE KEY target_invoice (target_invoice_no)
) ENGINE=InnoDB;
CREATE TABLE sync_invoice_item_map (
  shop_id VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  origin_installation_id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  source_invoice_no VARCHAR(50) NOT NULL,
  source_item_id BIGINT UNSIGNED NOT NULL,
  target_item_id BIGINT UNSIGNED NOT NULL,
  PRIMARY KEY (shop_id, origin_installation_id, source_invoice_no, source_item_id),
  UNIQUE KEY target_item (target_item_id)
) ENGINE=InnoDB;
