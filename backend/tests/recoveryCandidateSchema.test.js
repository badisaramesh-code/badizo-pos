'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { verifyScopedGrants, prepareCandidateSchema } = require('../services/recoveryCandidateSchema');
const database = 'badizo_recovery_12345678';
const config = { database, shopId: 'HFM001' };
const grants = [{ grant: 'GRANT USAGE ON *.* TO test' }, { grant: 'GRANT ALL PRIVILEGES ON `badizo\\_recovery\\_12345678`.* TO test' }];
function fixture({ wrongSchema = false, orphan = false, changed = false, view = false, myisam = false, missingColumn = null } = {}) {
  const statements = []; let snapshots = 0;
  const columns = require('../services/recoverySchemaContract').tables;
  return { statements, query: async sql => {
    statements.push(sql);
    if (sql.startsWith('SELECT DATABASE()')) return [[{ database_name: database, version: '8.0.46' }]];
    if (sql === 'SHOW GRANTS') return [grants];
    if(sql.includes('DATA_TYPE AS data_type'))return [[...Array.from({length:6},()=>({data_type:'decimal'}))]];
    if(sql.includes('information_schema.TABLES'))return [Object.keys(columns).filter(name => !view || name !== 'invoices').map(table_name => ({table_name,engine:myisam && table_name === 'invoices' ? 'MyISAM' : 'InnoDB'}))];
    if(sql.includes('information_schema.STATISTICS'))return [[{table_name:'invoices',non_unique:0,columns_list:'invoice_no',prefix_columns:0},{table_name:'invoices',non_unique:0,columns_list:'checkout_request_id',prefix_columns:0},{table_name:'invoice_sequences',non_unique:0,columns_list:'financial_year,counter_no',prefix_columns:0}]];
    if (sql.includes('information_schema.COLUMNS')) return [Object.entries(columns).flatMap(([table_name, fields]) => fields.map(column_name => ({ table_name, column_name }))).filter(row => (!wrongSchema || row.column_name !== 'checkout_request_id') && `${row.table_name}.${row.column_name}` !== missingColumn)];
    if (sql.includes('AS invoiceTotal')) return [[{ products: 10, invoices: ++snapshots > 1 && changed ? 21 : 20, invoiceTotal: '100.00' }]];
    if (sql.includes('AS orphanItems')) return [[{ orphanItems: orphan ? 1 : 0, orphanPayments: 0, invalidQuantities: 0, negativeInvoices: 0, owners: 1 }]];
    if (sql.startsWith('CREATE TABLE IF NOT EXISTS')) return [[]];
    throw Error('Unexpected candidate operation');
  } };
}
test('global privileges, grant options and wildcard database scopes are rejected', () => {
  verifyScopedGrants(grants, database);
  for (const value of ['GRANT ALL PRIVILEGES ON *.* TO test', 'GRANT ALL PRIVILEGES ON `badizo_recovery_12345678`.* TO test',
    'GRANT ALL PRIVILEGES ON `badizo\\_recovery\\_12345678`.* TO test WITH GRANT OPTION']) {
    assert.throws(() => verifyScopedGrants([{ grant: value }], database));
  }
});
test('current-compatible candidates get additive tables without any user or business-data modifications', async () => {
  const connection = fixture(); const result = await prepareCandidateSchema(connection, config);
  assert.equal(result.candidateSchemaVerified, true); assert.equal(result.candidateDataIntegrityVerified, true);assert.equal(result.businessReconciliationVerified, false);
  assert.ok(connection.statements.some(sql => sql.includes('CREATE TABLE IF NOT EXISTS abandoned_checkouts')));
  assert.ok(connection.statements.every(sql => /^(SELECT|SHOW|CREATE TABLE IF NOT EXISTS)/.test(sql)));
});
test('active database names and unsupported old schemas fail closed', async () => {
  const connection = fixture();
  await assert.rejects(prepareCandidateSchema(connection, { ...config, database: 'badizo_pos' }), /isolated/);
  assert.equal(connection.statements.length, 0);
  const old = fixture({ wrongSchema: true });
  await assert.rejects(prepareCandidateSchema(old, config), /reviewed migration/);
  assert.equal(old.statements.some(sql => sql.startsWith('CREATE')), false);
});
test('orphaned financial data or changes during staging never produce an activation proof', async () => {
  await assert.rejects(prepareCandidateSchema(fixture({ orphan: true }), config), /relationships/);
  await assert.rejects(prepareCandidateSchema(fixture({ changed: true }), config), /changed/);
});

test('views, nontransactional tables and missing critical columns fail before additive changes', async () => {
  for (const options of [{view:true}, {myisam:true}, {missingColumn:'invoices.grand_total'}]) {
    const connection = fixture(options);
    await assert.rejects(prepareCandidateSchema(connection, config), /BASE TABLE|reviewed migration/);
    assert.equal(connection.statements.some(sql => sql.startsWith('CREATE')), false);
  }
});
