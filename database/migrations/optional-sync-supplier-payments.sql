-- Optional: install only in explicitly enrolled sync databases.
CREATE TABLE IF NOT EXISTS sync_supplier_payment_map (
  shop_id VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  origin_installation_id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  source_payment_id BIGINT UNSIGNED NOT NULL,
  target_payment_id BIGINT UNSIGNED NOT NULL,
  payload_hash CHAR(64) NOT NULL,
  PRIMARY KEY (shop_id,origin_installation_id,source_payment_id),
  UNIQUE KEY uq_sync_supplier_payment_target (target_payment_id)
) ENGINE=InnoDB;
