'use strict';

function invoiceEpochForOperation(operationId) {
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(operationId || '')) throw Error('A durable recovery operation UUID is required.');
  const alphabet = '0123456789abcdefghjkmnpqrstvwxyz';
  let value = BigInt('0x' + operationId.replace(/-/g, '')), encoded = '';
  for (let index = 0; index < 26; index++) { encoded = alphabet[Number(value % 32n)] + encoded; value /= 32n; }
  return encoded;
}
function validInvoiceEpoch(value) {
  return /^[0-7][0-9abcdefghjkmnpqrstvwxyz]{25}$/.test(value || '');
}
function recoveryInvoicePrefix(nodeRole, epoch) {
  if (!['local-server', 'cloud-standby', 'cloud-active'].includes(nodeRole) || !validInvoiceEpoch(epoch)) throw Error('Invalid recovery invoice namespace.');
  return `${nodeRole === 'local-server' ? 'BZ' : 'CL'}${epoch}`;
}
function escapeLike(value) { return value.replace(/[=%_]/g, match => '=' + match); }

// Candidate-only preparation. No active billing database or printed invoice is edited.
async function prepareRecoveryInvoiceNumbers({ candidateConnection, previousConnection = null, nodeRole, operationId }) {
  const invoiceEpoch = invoiceEpochForOperation(operationId);
  const invoicePrefix = recoveryInvoicePrefix(nodeRole, invoiceEpoch);
  const [[identity]] = await candidateConnection.query('SELECT DATABASE() AS database_name');
  if (!/^badizo_recovery_[a-z0-9]{8,32}$/.test(identity?.database_name || '')) throw Error('Invoice recovery requires an isolated candidate database.');
  if (candidateConnection === previousConnection) throw Error('Candidate and previous connections must differ.');
  const [columns] = await candidateConnection.query("SELECT TABLE_NAME AS table_name, CHARACTER_MAXIMUM_LENGTH AS width FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND COLUMN_NAME='invoice_no'");
  for (const table of ['invoices', 'invoice_items', 'invoice_payments']) {
    if (!columns.some(column => column.table_name === table && Number(column.width) >= 50)) throw Error('Candidate invoice columns are incompatible with recovery numbering.');
  }
  if (columns.some(column => Number(column.width) < 50)) throw Error('An invoice reference column is too short for recovery numbering.');
  const [alreadyUsed] = await candidateConnection.query("SELECT invoice_no FROM invoices WHERE invoice_no LIKE ? ESCAPE '=' LIMIT 1", [escapeLike(invoicePrefix) + '/%']);
  if (alreadyUsed.length) throw Error('The recovery invoice namespace has already accepted bills. Do not reuse or replace it.');
  const [candidateSequences] = await candidateConnection.query('SELECT financial_year,MAX(next_number) AS next_number FROM invoice_sequences GROUP BY financial_year');
  let previous = [];
  if (previousConnection) {
    const [[prior]] = await previousConnection.query('SELECT DATABASE() AS database_name');
    if (prior.database_name === identity.database_name) throw Error('Previous database must not be the candidate.');
    [previous] = await previousConnection.query('SELECT financial_year, MAX(next_number) AS next_number FROM invoice_sequences GROUP BY financial_year');
  }
  for (const row of [...previous, ...candidateSequences]) {
    if (!/^(?:\d{2}|\d{4})-\d{2}$/.test(row.financial_year || '') || !Number.isSafeInteger(Number(row.next_number)) || Number(row.next_number) < 1 || Number(row.next_number) > 999999999) throw Error('Invoice sequence exceeds the supported recovery number length.');
  }
  await candidateConnection.beginTransaction();
  try {
    for (const row of previous) {
      await candidateConnection.query('INSERT INTO invoice_sequences (financial_year,counter_no,next_number) VALUES (?,0,?) ON DUPLICATE KEY UPDATE next_number=GREATEST(next_number,VALUES(next_number))', [row.financial_year, Number(row.next_number)]);
    }
    await candidateConnection.commit();
  } catch (error) { await candidateConnection.rollback(); throw error; }
  return { invoiceNumbersVerified: true, invoiceEpoch, invoicePrefix,
    previousHighWaterPreserved: !!previousConnection, source: 'fresh-recovery-operation-namespace', operationId };
}
module.exports = { invoiceEpochForOperation, validInvoiceEpoch, recoveryInvoicePrefix, prepareRecoveryInvoiceNumbers, escapeLike };
