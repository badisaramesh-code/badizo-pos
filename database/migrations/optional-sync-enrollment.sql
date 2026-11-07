-- Installer-owned binding. No startup code creates or approves this record.
CREATE TABLE sync_enrollment (
  singleton TINYINT UNSIGNED NOT NULL PRIMARY KEY,
  shop_id VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  installation_id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  peer_installation_id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  baseline_id CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  activation_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  contract_version INT UNSIGNED NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT FALSE,
  enrolled_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  CONSTRAINT sync_enrollment_singleton CHECK (singleton=1)
) ENGINE=InnoDB;
