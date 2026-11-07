-- OPTIONAL infrastructure only. Never run automatically on POS startup.
-- Run against an isolated validation database first. No transfer handlers are
-- enabled by creating this table; all business writes and receipts must share
-- one InnoDB transaction. Do not purge receipts while events can be retried.
CREATE TABLE sync_inbox (
  shop_id VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  event_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  origin_installation_id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  payload_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  applied_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (shop_id, event_id)
) ENGINE=InnoDB;
