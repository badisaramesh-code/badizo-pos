const test=require('node:test'),assert=require('node:assert/strict');
const {reconcilePurchaseInventory:merge}=require('../services/purchaseInventoryReconciliation');
const product={id:1,barcode:'P',stock_qty:'10.00',product_name:'P',sale_price:'10.00'};
const batch={id:1,barcode:'P',batch_no:'A',expiry_date:null,quantity_received:'10.00',quantity_available:'10.00',purchase_price:'5.00'};
const before={products:[product],batches:[batch]};
const after={products:[{...product,stock_qty:'12.00'}],batches:[{...batch,quantity_received:'12.00',quantity_available:'12.00'}]};
test('purchase quantity edit preserves independent sales, price changes and extra batches',()=>{
  const current={products:[{...product,stock_qty:'11.00',sale_price:'11.00'}],batches:[{...batch,quantity_available:'7.00'},{...batch,id:2,batch_no:'B',quantity_received:'4.00',quantity_available:'4.00'}]};
  const merged=merge(before,after,current);assert.equal(merged.products[0].stock_qty,'13.00');assert.equal(merged.products[0].sale_price,'11.00');
  assert.equal(merged.batches.find(row=>row.batch_no==='A').quantity_available,'9.00');assert.equal(merged.batches.find(row=>row.batch_no==='B').quantity_available,'4.00');
});
test('reduction cannot consume already sold stock or delete a changed batch',()=>{
  const current={products:[{...product,stock_qty:'1.00'}],batches:[{...batch,quantity_available:'1.00'}]};
  assert.throws(()=>merge(before,{products:[{...product,stock_qty:'5.00'}],batches:[{...batch,quantity_received:'5.00',quantity_available:'5.00'}]},current),/already sold/);
  assert.throws(()=>merge(before,{products:[product],batches:[]},current),/sold or changed/);
});
test('conflicting purchase metadata is preserved for review',()=>{
  assert.throws(()=>merge(before,{...after,batches:[{...after.batches[0],purchase_price:'6.00'}]},{products:[product],batches:[{...batch,purchase_price:'7.00'}]}),/metadata conflicts/);
});
