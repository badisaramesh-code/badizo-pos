-- Opt-in checkout retry identity. No existing invoice table is altered.
CREATE TABLE sync_checkout_requests (
  request_id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
  intent_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  invoice_no VARCHAR(50) NOT NULL,
  recorded_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  UNIQUE KEY checkout_invoice (invoice_no)
) ENGINE=InnoDB;
