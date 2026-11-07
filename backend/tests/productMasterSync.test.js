const test=require('node:test');
const assert=require('node:assert/strict');
const {beginProductCapture,finishProductCapture,applyProductMaster,applyProductDeletion}=require('../services/productMasterSync');
const env={BADIZO_SYNC_PRODUCT_CAPTURE:'true',BADIZO_SHOP_ID:'HFM001',BADIZO_INSTALLATION_ID:'local-test',BADIZO_SYNC_PEER_INSTALLATION_ID:'cloud-test'};
const old={id:1,barcode:'P1',product_name:'Milk',stock_qty:'10.00',sale_price:'20.00'};
function target(row){
  const writes=[];
  return {writes,async query(sql){if(typeof sql==='object')return [[row]];return [Object.keys(old).map(Field=>({Field}))];},async execute(sql,args){writes.push({sql,args});return [[]];}};
}
test('disabled capture does not query the existing local database',async()=>{
  const connection={query(){throw Error('Unexpected database access');}};
  assert.equal(await beginProductCapture(connection,'barcode=?',['P1'],{}),null);
  await finishProductCapture(connection,null,{});
});
test('a metadata change preserves receiver sales stock and receiver identity',async()=>{
  const c=target({...old,id:500,stock_qty:'7.00'});
  await applyProductMaster(c,{before:old,after:{...old,product_name:'Fresh Milk'}});
  assert.equal(c.writes.length,1);
  assert.match(c.writes[0].sql,/SET `product_name`=/);
  assert.deepEqual(c.writes[0].args,['Fresh Milk',500]);
});
test('an absolute stock edit cannot overwrite receiver sales',async()=>{
  const c=target({...old,stock_qty:'7.00'});
  await assert.rejects(applyProductMaster(c,{before:old,after:{...old,stock_qty:'20.00'}}),/review required/);
  assert.equal(c.writes.length,0);
});
test('a divergent price requires review without partial field writes',async()=>{
  const c=target({...old,sale_price:'21.00'});
  await assert.rejects(applyProductMaster(c,{before:old,after:{...old,product_name:'Fresh Milk',sale_price:'22.00'}}),/review required/);
  assert.equal(c.writes.length,0);
});
test('queue failure propagates to the caller transaction',async()=>{
  let reads=0;
  const c={async query(sql){assert.equal(typeof sql,'object');if(!reads++)assert.match(sql.sql,/FOR UPDATE/);return [[reads===1?old:{...old,sale_price:'22.00'}]];},async execute(sql,args){assert.match(sql,/sync_outbox/);const event=JSON.parse(args[3]);assert.equal(event.type,'pos.product.changed');assert.deepEqual(event.payload.before,old);throw Error('Queue failed');}};
  const start=await beginProductCapture(c,'barcode=?',['P1'],env);
  await assert.rejects(finishProductCapture(c,start,env),/Queue failed/);
});
test('timestamp-only changes do not create sync events',async()=>{
  let reads=0;
  const c={async query(){return [[{...old,updated_at:String(++reads)}]];},execute(){throw Error('Unexpected queue write');}};
  const start=await beginProductCapture(c,'barcode=?',['P1'],env);
  await finishProductCapture(c,start,env);
});
test('deletion checks every product before deleting a shared promotion',async()=>{
  const second={...old,id:2,barcode:'P2'};
  const offer={id:8,trigger_barcode:'P1',free_barcode:'P2',free_qty_remaining:'3.00'};
  const products=[old,second].map(before=>({before,beforeRelations:{batches:[],offers:[offer]},afterRelations:{batches:[],offers:[]}}));
  const writes=[];
  let checked=0;
  const connection={async query(query,args){
    const sql=query.sql;
    if(sql.includes('FROM products')){checked++;return [[args[0]==='P1'?old:second]];}
    if(sql.includes('product_batches'))return [[]];
    return [[{...offer,id:80}]];
  },async execute(sql,args){assert.equal(checked,2);writes.push({sql,args});return [[]];}};
  await applyProductDeletion(connection,{products});
  assert.equal(writes.filter(row=>row.sql.includes('batch_free_offers')).length,1);
  assert.deepEqual(writes[0].args,['80']);
});
test('deletion refuses changed stock without deleting dependencies',async()=>{
  const connection={async query(){return [[{...old,stock_qty:'9.00'}]];},execute(){throw Error('Unexpected delete');}};
  await assert.rejects(applyProductDeletion(connection,{products:[{before:old,beforeRelations:{batches:[],offers:[]},afterRelations:{batches:[],offers:[]}}]}),/changed before deletion/);
});
