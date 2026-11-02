const test=require('node:test'),assert=require('node:assert/strict');
const {captureCheckout}=require('../services/checkoutSyncCapture');
test('existing installations do not access any sync tables by default',async()=>{
  assert.equal(await captureCheckout({query(){throw Error('Unexpected query');},execute(){throw Error('Unexpected write');}},'invoice',{}),null);
});
test('enabled capture enqueues only after reading complete checkout records without committing',async()=>{
  let writes=0;
  const connection={query:async({sql})=>[sql.includes('FROM invoices ')?[{id:1,invoice_no:'test'}]:[]],execute:async(sql,args)=>{assert.match(sql,/INSERT INTO sync_outbox/);const event=JSON.parse(args[3]);assert.equal(event.payload.invoice.invoice_no,'test');assert.deepEqual(event.payload.batchAllocations,[]);writes++;}};
  await captureCheckout(connection,'test',{BADIZO_SYNC_CHECKOUT_CAPTURE:'true',BADIZO_SHOP_ID:'HFM001',BADIZO_INSTALLATION_ID:'local-test',BADIZO_SYNC_PEER_INSTALLATION_ID:'cloud-test'});
  assert.equal(writes,1);
});
