const test=require('node:test'),assert=require('node:assert/strict');
const {applyCancellation}=require('../services/invoiceCancellationSyncHandler');
const {applyReturn}=require('../services/invoiceReturnSyncHandler');
test('lifecycle application requires a trusted context and valid operation before SQL',async()=>{
  const connection={execute(){throw Error('Unexpected SQL');}};
  for(const handler of [applyCancellation,applyReturn]){
    for(const payload of [null,{}, {change:{kind:'void'},invoice:{invoice_status:'CANCELLED'}}])await assert.rejects(handler(connection,payload),/Unsupported/);
  }
});
test('an unmapped origin cannot cancel or return a same-number local invoice',async()=>{
  const context={shopId:'HFM001',originInstallationId:'other-installation'};
  let queries=0;
  const connection={async execute(sql,args){queries++;assert.match(sql,/sync_invoice_map/);assert.equal(args[1],context.originInstallationId);return [[]];}};
  await assert.rejects(applyCancellation(connection,{change:{kind:'void'},invoice:{invoice_no:'INV-1',invoice_status:'CANCELLED',cancel_reason:'test',cancelled_by:'owner',cancelled_at:'2026-11-02 12:00:00'},returns:[],returnItems:[]},context),/waiting for its originating checkout/);
  await assert.rejects(applyReturn(connection,{change:{kind:'return',returnNo:'SR-1'},invoice:{invoice_no:'INV-1',invoice_status:'RETURNED'},returns:[],returnItems:[],items:[]},context),/waiting for its originating checkout/);
  assert.equal(queries,2);
});
