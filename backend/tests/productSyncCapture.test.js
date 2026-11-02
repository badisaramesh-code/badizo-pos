const test=require('node:test'),assert=require('node:assert/strict');
const {updatePriceListWithCapture}=require('../services/productSyncCapture');
test('default price-list update executes only the original query',async()=>{
  let count=0;const connection={query(sql,values){count++;assert.equal(sql,'UPDATE existing');assert.deepEqual(values,[10]);return [{affectedRows:1}];}};
  assert.deepEqual(await updatePriceListWithCapture(connection,{sql:'UPDATE existing',values:[10]},[1],'sale_price',{}),[{affectedRows:1}]);assert.equal(count,1);
});
test('capture uses locked current values and fails caller operation when queue write fails',async()=>{
  const calls=[];const connection={async query(sql){calls.push(sql);if(sql.includes('FOR UPDATE'))return [[{id:1,barcode:'P1',product_name:'Milk',sale_price:'10.00'}]];if(sql.startsWith('UPDATE'))return [{affectedRows:1}];return [[{id:1,barcode:'P1',product_name:'Milk',sale_price:'11.00'}]];},async execute(sql,args){assert.match(sql,/sync_outbox/);const event=JSON.parse(args[3]);assert.deepEqual(event.payload.changes,[{field:'sale_price',before:'10.00',after:'11.00'}]);throw Error('Queue unavailable');}};
  await assert.rejects(updatePriceListWithCapture(connection,{sql:'UPDATE existing',values:[]},[1],'sale_price',{BADIZO_SYNC_PRODUCT_CAPTURE:'true',BADIZO_SHOP_ID:'HFM001',BADIZO_INSTALLATION_ID:'local-test',BADIZO_SYNC_PEER_INSTALLATION_ID:'cloud-test'}),/Queue unavailable/);
  assert.match(calls[0],/FOR UPDATE/);assert.match(calls[1],/^UPDATE/);
});
