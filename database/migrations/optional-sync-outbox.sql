-- Opt-in only. Not installed by POS startup. Requires transactional capture.
CREATE TABLE sync_outbox (
  sequence_no BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  event_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL UNIQUE,
  shop_id VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  origin_installation_id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  event_json JSON NOT NULL,
  payload_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  created_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  acknowledged_at TIMESTAMP(6) NULL,
  INDEX pending_events (shop_id,origin_installation_id,acknowledged_at,sequence_no)
) ENGINE=InnoDB;
