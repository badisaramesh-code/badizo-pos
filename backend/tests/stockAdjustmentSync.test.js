const test=require('node:test'),assert=require('node:assert/strict');
const {quantity,format,captureStockAdjustment,applyStockAdjustment}=require('../services/stockAdjustmentSync');
test('stock arithmetic preserves signed two-decimal quantities exactly',()=>{
  for(const text of ['-0.01','9999999999.99','0.00','-12.50'])assert.equal(format(quantity(text)),text);
  for(const value of [null,'1e2','1.001','10000000000'])assert.throws(()=>quantity(value));
});
test('stock capture disabled by default performs no database access',async()=>{
  assert.equal(await captureStockAdjustment({query(){throw Error('Unexpected SQL');}},1,{}),null);
});
test('invalid stock events are rejected before business queries',async()=>{
  const connection={execute(){throw Error('Unexpected SQL');}};
  for(const payload of [null,{}, {adjustment:{}}])await assert.rejects(applyStockAdjustment(connection,payload,{shopId:'HFM001',originInstallationId:'cloud-test'}),/Invalid stock adjustment event/);
});
