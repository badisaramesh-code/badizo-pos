'use strict';
const { ensureSchema: ensureCheckoutSchema } = require('./checkoutAbandonment');
const { ensureSchema: ensureDiarySchema } = require('./paymentDiary');
const { tables: required } = require('./recoverySchemaContract');
const additive = new Set(['invoice_reprints','abandoned_checkouts','parked_checkout_reviews','checkout_recovery_events',
  'local_payment_diary','local_payment_diary_payments','local_payment_diary_years','local_payment_diary_changes']);

function verifyScopedGrants(rows, database) {
  const escaped = database.replace(/_/g, '\\_');
  let scoped = false;
  for (const row of rows) {
    const grant = Object.values(row)[0];
    if (typeof grant !== 'string' || grant.includes('WITH GRANT OPTION')) throw Error('Candidate privileges are not isolated.');
    if (/^GRANT USAGE ON \*\.\* TO /.test(grant)) continue;
    const match = grant.match(/^GRANT ([A-Z_, ]+) ON `([^`]+)`\.\* TO /);
    if (!match || match[2] !== escaped) throw Error('Only database-scoped candidate privileges are allowed.');
    scoped = true;
  }
  if (!scoped) throw Error('Candidate-scoped schema privileges are required.');
}
async function prepareCandidateSchema(connection, { shopId, database }) {
  if (!/^badizo_recovery_[a-z0-9]{8,32}$/.test(database || '') || !/^[A-Z][A-Z0-9_-]{2,31}$/.test(shopId || '')) throw Error('An isolated shop recovery candidate is required.');
  const [[identity]] = await connection.query('SELECT DATABASE() AS database_name, VERSION() AS version');
  if (identity.database_name !== database || !/^8\.0\./.test(identity.version)) throw Error('Candidate database or MySQL version differs.');
  const [grants] = await connection.query('SHOW GRANTS');
  verifyScopedGrants(grants, database);
  const [columns] = await connection.query('SELECT TABLE_NAME AS table_name,COLUMN_NAME AS column_name FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE()');
  for (const [table, fields] of Object.entries(required)) {
    if (additive.has(table) && !columns.some(row => row.table_name === table)) continue;
    for (const field of fields) if (!columns.some(row => row.table_name === table && row.column_name === field)) throw Error(`Unsupported backup schema: ${table}.${field}. A reviewed migration is required.`);
  }
  const [engines] = await connection.query("SELECT TABLE_NAME AS table_name,ENGINE AS engine FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_TYPE='BASE TABLE'");
  for (const table of Object.keys(required)) {
    if (additive.has(table) && !columns.some(row => row.table_name === table)) continue;
    if (!engines.some(row => row.table_name === table && row.engine === 'InnoDB')) throw Error(`Required recovery object ${table} must be an InnoDB BASE TABLE.`);
  }
  if (!engines.length || engines.some(row => row.engine !== 'InnoDB')) throw Error('Every restored POS table must use InnoDB for transactional recovery.');
  const [moneyColumns] = await connection.query("SELECT TABLE_NAME AS table_name,COLUMN_NAME AS column_name,DATA_TYPE AS data_type FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND ((TABLE_NAME='invoices' AND COLUMN_NAME='grand_total') OR (TABLE_NAME='invoice_items' AND COLUMN_NAME IN ('quantity','sale_price','returned_qty')) OR (TABLE_NAME='invoice_payments' AND COLUMN_NAME='amount') OR (TABLE_NAME='products' AND COLUMN_NAME='stock_qty'))");
  if (moneyColumns.length !== 6 || moneyColumns.some(row => row.data_type !== 'decimal')) throw Error('Financial and stock columns require the reviewed exact decimal types.');
  const [indexes] = await connection.query("SELECT TABLE_NAME AS table_name,INDEX_NAME AS index_name,NON_UNIQUE AS non_unique,GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX) AS columns_list,SUM(SUB_PART IS NOT NULL) AS prefix_columns FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME IN ('invoices','invoice_sequences') GROUP BY TABLE_NAME,INDEX_NAME,NON_UNIQUE");
  for (const [table, fields] of [['invoices','invoice_no'],['invoices','checkout_request_id'],['invoice_sequences','financial_year,counter_no']]) {
    if (!indexes.some(row => row.table_name === table && Number(row.non_unique) === 0 && row.columns_list === fields && Number(row.prefix_columns) === 0)) throw Error('Required invoice idempotency or sequence uniqueness is missing.');
  }
  const snapshotSql = `SELECT (SELECT COUNT(*) FROM products) AS products,
    (SELECT COUNT(*) FROM invoices) AS invoices,(SELECT COUNT(*) FROM invoice_items) AS items,
    (SELECT COUNT(*) FROM invoice_payments) AS payments,
    (SELECT CAST(COALESCE(SUM(grand_total),0) AS CHAR) FROM invoices) AS invoiceTotal,
    (SELECT CAST(COALESCE(SUM(amount),0) AS CHAR) FROM invoice_payments) AS paymentTotal,
    (SELECT CAST(COALESCE(SUM(stock_qty),0) AS CHAR) FROM products) AS stockTotal`;
  const [[before]] = await connection.query(snapshotSql);
  // Explicitly reviewed additive changes only; never invoke the application initializer,
  // seed users, modify passwords/settings or run arbitrary migrations from the upload.
  await require('./invoiceReprints').ensureSchema(connection);
  await ensureCheckoutSchema(connection);
  await ensureDiarySchema(connection);
  const [[invalid]] = await connection.query(`SELECT
    (SELECT COUNT(*) FROM invoice_items ii LEFT JOIN invoices i ON i.invoice_no=ii.invoice_no WHERE i.invoice_no IS NULL) AS orphanItems,
    (SELECT COUNT(*) FROM invoice_payments p LEFT JOIN invoices i ON i.invoice_no=p.invoice_no WHERE i.invoice_no IS NULL) AS orphanPayments,
    (SELECT COUNT(*) FROM invoice_items WHERE quantity<0 OR returned_qty<0 OR returned_qty>quantity) AS invalidQuantities,
    (SELECT COUNT(*) FROM invoices WHERE grand_total<0) AS negativeInvoices,
    (SELECT COUNT(*) FROM users WHERE role='SERVER' AND is_active=1) AS owners`);
  if (['orphanItems', 'orphanPayments', 'invalidQuantities', 'negativeInvoices'].some(key => Number(invalid[key]) !== 0) || Number(invalid.owners) < 1) throw Error('Candidate business relationships or recovery owner access failed verification.');
  const [[after]] = await connection.query(snapshotSql);
  if (JSON.stringify(before) !== JSON.stringify(after)) throw Error('Candidate business data changed during schema preparation.');
  return { candidateSchemaVerified: true, candidateDataIntegrityVerified: true, businessReconciliationVerified: false, shopId, database, summary: after,
    migrations: ['checkout-recovery-additive', 'payment-diary-additive','invoice-reprints-additive'], activeDatabaseChanged: false };
}
module.exports = { verifyScopedGrants, prepareCandidateSchema };
