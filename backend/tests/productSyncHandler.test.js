const test=require('node:test'),assert=require('node:assert/strict');
const {normalize,applyProductFields}=require('../services/productSyncHandler');
test('money comparison preserves exact decimal semantics and rejects unsupported values',()=>{
  assert.equal(normalize('sale_price','12.5'),'12.50');
  assert.equal(normalize('sale_price','0012.50'),'12.50');
  for(const value of [-1,Infinity,'1.234','1e3',null])assert.throws(()=>normalize('sale_price',value));
  assert.throws(()=>normalize('stock_qty',100));
});
test('unknown fields and stale product edits cannot write',async()=>{
  let writes=0;
  const connection={execute:async(sql)=>{if(sql.startsWith('SELECT'))return [[{product_name:'Rice',sale_price:'15.00'}]];writes++;return [{}];}};
  await assert.rejects(applyProductFields(connection,{barcode:'123',changes:[{field:'stock_qty',before:1,after:2}]}));
  await assert.rejects(applyProductFields(connection,{barcode:'123',changes:[{field:'sale_price',before:'14.00',after:'16.00'}]}));
  assert.equal(writes,0);
  await applyProductFields(connection,{barcode:'123',changes:[{field:'sale_price',before:'15.00',after:'16.00'}]});assert.equal(writes,1);
});
