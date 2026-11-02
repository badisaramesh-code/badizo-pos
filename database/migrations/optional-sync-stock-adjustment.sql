-- Explicit opt-in migration. Never installed by ordinary POS startup.
CREATE TABLE sync_stock_adjustment_map (
  shop_id VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  origin_installation_id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  source_adjustment_id BIGINT UNSIGNED NOT NULL,
  target_adjustment_id BIGINT UNSIGNED NULL,
  source_json LONGTEXT NOT NULL,
  PRIMARY KEY (shop_id, origin_installation_id, source_adjustment_id),
  UNIQUE KEY target_adjustment (target_adjustment_id)
) ENGINE=InnoDB;
