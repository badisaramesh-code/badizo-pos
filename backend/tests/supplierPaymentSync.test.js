const test=require('node:test'),assert=require('node:assert/strict');
const {captureSupplierPayment,applySupplierPayment}=require('../services/supplierPaymentSync');
const context={shopId:'HFM001',originInstallationId:'local-test'};
const payload={payment:{id:1,inward_no:'I1',supplier_name:'Supplier',supplier_gstin:'',amount:'10.00'},before:{grand_total:'100.00',paid_amount:'0.00',due_amount:'100.00'},after:{grand_total:'100.00',paid_amount:'10.00',due_amount:'90.00'}};
test('supplier payment capture is disabled without opt-in',async()=>{
  await captureSupplierPayment({query(){throw Error('Unexpected query');}},null,null,{});
});
test('supplier payment rejects inconsistent source totals before SQL',async()=>{
  await assert.rejects(applySupplierPayment({}, {...payload,after:{...payload.after,paid_amount:'20.00'}},context),/do not reconcile/);
});
test('concurrent supplier payments that overpay cannot overwrite balances',async()=>{
  const connection={async execute(sql){assert.match(sql,/^SELECT/);return [[]];},async query(){return [[{posting_status:'POSTED',grand_total:'100.00',paid_amount:'95.00',due_amount:'5.00',supplier_name:'Supplier',supplier_gstin:''}]];}};
  await assert.rejects(applySupplierPayment(connection,payload,context),/exceed purchase total/);
});
test('a mapped source payment cannot be reused with new content',async()=>{
  await assert.rejects(applySupplierPayment({async execute(){return [[{payload_hash:'different'}]];}},payload,context),/identity was reused/);
});
