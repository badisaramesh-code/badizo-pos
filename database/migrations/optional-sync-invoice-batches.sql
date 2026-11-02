-- Explicitly install in a validated receiver; never on ordinary startup.
CREATE TABLE sync_invoice_batch_map (
  shop_id VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  origin_installation_id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  source_invoice_no VARCHAR(50) NOT NULL,
  source_allocation_id BIGINT UNSIGNED NOT NULL,
  target_allocation_id BIGINT UNSIGNED NOT NULL,
  target_batch_id BIGINT UNSIGNED NOT NULL,
  PRIMARY KEY (shop_id, origin_installation_id, source_invoice_no, source_allocation_id),
  UNIQUE KEY target_allocation (target_allocation_id)
) ENGINE=InnoDB;
