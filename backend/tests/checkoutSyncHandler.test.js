const test=require('node:test'),assert=require('node:assert/strict');
const {applyCheckout,decimal}=require('../services/checkoutSyncHandler');
test('invoice decimals use exact arithmetic',()=>{
  assert.equal(decimal('99999999.99'),9999999999n);assert.equal(decimal('0.10'),10n);
  for(const invalid of ['-1','1.234','1e3',null])assert.throws(()=>decimal(invalid));
});
test('unsupported checkout profiles fail before database access',async()=>{
  const connection={execute(){throw Error('Unexpected database access');},query(){throw Error('Unexpected database access');}};
  for(const payload of [null,{}, {invoice:{invoice_no:'test'},items:[],payments:[],batchAllocations:[],loyaltyTransactions:[]}])await assert.rejects(applyCheckout(connection,payload),/Invalid checkout|different application profile/);
});
