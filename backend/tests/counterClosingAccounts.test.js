const test = require('node:test');
const assert = require('node:assert/strict');
const { matchingAccounts } = require('../utils/closingAccountSearch');

test('three letters and a single misspelling find canonical names across sources', () => {
  const rows = [
    { name: 'Lankapalli', kind: 'CUSTOMER' },
    { name: 'Lankapalli Stores', kind: 'LOCAL' },
    { name: 'Lankapalli Stores', kind: 'NON_LOCAL' },
    { name: 'Unrelated', kind: 'CUSTOMER' }
  ];
  assert.deepEqual(matchingAccounts(rows, 'la'), []);
  for (const q of ['lan', 'LANKAPALLY', 'lankpalli', 'lannkapalli']) {
    assert.deepEqual(matchingAccounts(rows, q), rows.slice(0, 3));
  }
});

test('saved counter handover response omits snapshots, reconciliation totals and automatic sales entries', async () => {
  const rows = [{ id: 8, counter_sales: 444, cash_sales: 333, all_counter_sales: 999, cr_total: 555,
    variance_amount: 88, opening_cash: 50 }];
  const entries = [{ entry_type: 'SALES', details: 'Today Sale', amount: 444 },
    { entry_type: 'CLOSING_CUSTOMER', details: 'Lankapalli', amount: 125 }];
  const dbPath = require.resolve('../config/db');
  require.cache[dbPath] = { exports: { query: async sql => {
    if (sql.includes('FROM counter_handover_sheets')) return [rows];
    if (sql.includes('FROM counter_handover_entries')) return [entries];
    if (sql.includes('FROM counter_handover_denominations')) return [[]];
    throw Error('Unexpected query in restricted view');
  } } };
  const router = require('../routes/counterClosing');
  const handler = router.stack.find(layer => layer.route?.path === '/handover' && layer.route.methods.get).route.stack[0].handle;
  let result;
  await handler({ user: { role: 'COUNTER', counter_no: 1 }, query: {} }, { json: data => { result = data; } });
  assert.deepEqual(result.snapshot, {});
  assert.equal(result.sheet.counter_sales, undefined);
  assert.equal(result.sheet.cr_total, undefined);
  assert.deepEqual(result.sheet.entries, [entries[1]]);
  assert.equal(result.sheet.opening_cash, 50);
});

test('closing search uses the same Named Ledgers accounts for GEN and ADV', async () => {
 const dbPath=require.resolve('../config/db');let queries=0;
 require.cache[dbPath].exports.query=async sql=>{queries++;
  if(sql.includes('FROM counter_cash_ledger_entries cle'))return [[{account_name:'GENERAL'},{account_name:'GENERAL'},{account_name:'ADVANCE'}]];
  if(sql.includes('FROM local_account_ledgers'))return [[{name:'LOCAL STORE',kind:'LOCAL'}]];
  throw Error('Unexpected account source');
 };
 const router=require('../routes/counterClosing');const handler=router.stack.find(layer=>layer.route?.path==='/accounts').route.stack[0].handle;
 const search=async(q,vendors='0')=>{let result;await handler({query:{q,vendors}}, {json:data=>{result=data;},status:()=>{throw Error('Search failed');}});return result;};
 assert.deepEqual(await search('GE'),[]);assert.equal(queries,0);
 assert.deepEqual(await search('GEN'),[{name:'GENERAL',kind:'NAMED_LEDGER'}]);
 assert.deepEqual(await search('ADV'),[{name:'ADVANCE',kind:'NAMED_LEDGER'}]);
 assert.deepEqual(await search('LOC','1'),[{name:'LOCAL STORE',kind:'LOCAL'}]);
});
