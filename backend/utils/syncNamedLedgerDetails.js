function normalizeAccount(value) {
  return String(value || '').trim().replace(/^Expense - /i, '').replace(/\s+/g, ' ').toUpperCase().slice(0, 160);
}
function conflict(message) {
  const error = new Error(message);
  error.status = 409;
  return error;
}
// The caller owns the transaction. Lock the sheet before its ledger rows, as closing saves do.
async function lockLedgerSource(connection, id) {
  const [references] = await connection.query('SELECT source_type, source_id FROM counter_cash_ledger_entries WHERE id = ?', [id]);
  const reference = references[0];
  if (reference?.source_type === 'COUNTER_HANDOVER') {
    await connection.query('SELECT id FROM counter_handover_sheets WHERE id = ? FOR UPDATE', [reference.source_id]);
  }
  const [entries] = await connection.query('SELECT * FROM counter_cash_ledger_entries WHERE id = ? FOR UPDATE', [id]);
  const entry = entries[0];
  if (entry && reference && (entry.source_type !== reference.source_type || entry.source_id !== reference.source_id)) {
    throw conflict('The closing entry changed. Reload the book and try again.');
  }
  return entry;
}
async function syncNamedLedgerDetails(connection, entry, details) {
  if (entry?.source_type !== 'COUNTER_HANDOVER') return;
  if (details.length > 180) {
    const error = new Error('Counter Closing Sheet details must be 180 characters or fewer.');
    error.status = 400;
    throw error;
  }
  const [sources] = await connection.query('SELECT * FROM counter_handover_entries WHERE sheet_id = ? FOR UPDATE', [entry.source_id]);
  const matches = sources.filter(row => normalizeAccount(row.details) === normalizeAccount(entry.account_name)
    && row.direction === entry.direction && Number(row.amount) === Number(entry.amount)
    && row.entry_type === entry.payment_mode
    && (!row.remarks || row.remarks === entry.details));
  if (matches.length !== 1) {
    throw conflict('Unable to identify the exact Counter Closing Sheet line. Reload and check the source sheet.');
  }
  await connection.query('UPDATE counter_handover_entries SET details = ? WHERE id = ?', [details, matches[0].id]);
  // Keep the source account aligned so another edit and closing-sheet resave retain the link.
  await connection.query('UPDATE counter_cash_ledger_entries SET account_name = ? WHERE id = ?', [normalizeAccount(details), entry.id]);
  await connection.query('UPDATE counter_handover_sheets SET updated_at = CURRENT_TIMESTAMP WHERE id = ?', [entry.source_id]);
}
module.exports = { lockLedgerSource, syncNamedLedgerDetails };
