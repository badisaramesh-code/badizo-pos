-- Explicit installation only. Does not enable capture, transfer or billing.
CREATE TABLE sync_worker_state (
  shop_id VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  installation_id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  schedule_key VARCHAR(100) NOT NULL DEFAULT '',
  next_scheduled_ms BIGINT NULL,
  retry_at_ms BIGINT NULL,
  last_success_ms BIGINT NULL,
  failure_count INT UNSIGNED NOT NULL DEFAULT 0,
  manual_requested BOOLEAN NOT NULL DEFAULT FALSE,
  request_generation BIGINT UNSIGNED NOT NULL DEFAULT 0,
  last_requested_by VARCHAR(100) NULL,
  phase VARCHAR(24) NOT NULL DEFAULT 'idle',
  PRIMARY KEY (shop_id, installation_id)
) ENGINE=InnoDB;
