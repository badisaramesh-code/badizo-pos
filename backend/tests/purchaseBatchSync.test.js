const test=require('node:test'),assert=require('node:assert/strict');
const {beginPurchaseCapture,finishPurchaseCapture,applyPurchase}=require('../services/purchaseSync');
const {validateAllocations,originalBatchShape}=require('../services/invoiceBatchSync');
const {formatInwardNo}=require('../services/inwardNumberService');
test('ordinary local purchase paths do not query sync state',async()=>{
  const connection={query(){throw Error('Unexpected database query');}};
  assert.equal(await beginPurchaseCapture(connection,['P1'],'create',{}),null);
  assert.equal(await finishPurchaseCapture(connection,null,'INW/TEST',{}),undefined);
});
test('cloud purchase numbers cannot collide with the unchanged local format',()=>{
  assert.equal(formatInwardNo('2026-27',42,{}),'INW/2026-27/000042');
  assert.equal(formatInwardNo('2026-27',42,{BADIZO_NODE_ROLE:'cloud-active'}),'CLINW/2026-27/000042');
});
test('batch allocations require known lines and cannot exceed sold quantity',()=>{
  const row={id:1,invoice_item_id:9,invoice_no:'CL/TEST',barcode:'P1',batch_no:'A',expiry_date:'2027-12-31',quantity:'2.00',returned_qty:'0.00'};
  const payload={invoice:{invoice_no:'CL/TEST'},items:[{id:9,barcode:'P1',quantity:'2.00'}],batchAllocations:[row]};
  validateAllocations(payload);
  for(const change of [{quantity:'3.00'},{invoice_item_id:10},{returned_qty:'1.00'},{barcode:'P2'}])assert.throws(()=>validateAllocations({...payload,batchAllocations:[{...row,...change}]}));
  assert.throws(()=>validateAllocations({...payload,batchAllocations:[row,row]}));
  assert.deepEqual(originalBatchShape(payload,{batchAllocations:[{...row,returned_qty:'1.00'}]}),[row]);
  assert.throws(()=>originalBatchShape(payload,{batchAllocations:[{...row,batch_no:'WRONG'}]}));
});
test('unsupported purchase changes remain unacknowledged instead of overwriting history',async()=>{
  await assert.rejects(applyPurchase({execute(){throw Error('Unexpected SQL');}},{operation:'replace'}),/requires reconciliation/);
});
