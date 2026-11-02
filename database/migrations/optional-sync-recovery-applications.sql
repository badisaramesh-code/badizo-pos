-- Explicit opt-in only; never installed by normal POS startup.
CREATE TABLE sync_recovery_applications (
  shop_id VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  plan_id CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  revision INT UNSIGNED NOT NULL,
  head_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  actor VARCHAR(255) NOT NULL,
  review_json LONGTEXT NOT NULL,
  applied_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (shop_id,plan_id)
) ENGINE=InnoDB;
