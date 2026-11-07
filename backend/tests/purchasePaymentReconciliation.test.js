const test=require('node:test'),assert=require('node:assert/strict');
const {reconcilePurchasePayments}=require('../services/purchasePaymentReconciliation');
const before={inward_no:'INW/1',supplier_name:'Supplier',supplier_gstin:'',grand_total:'100.00',paid_amount:'20.00',due_amount:'80.00',payment_status:'PARTIAL'};
const payment={id:1,inward_no:'INW/1',amount:'20.00',payment_mode:'Cash',reference_no:'A'};
const base={before,after:{...before,grand_total:'120.00',due_amount:'100.00'},sourcePayments:[payment],target:before,targetPayments:[{...payment,id:99}]};
test('purchase edit preserves mapped payment history and recomputes balance',()=>{
  const result=reconcilePurchasePayments(base);assert.equal(result.paid_amount,'20.00');assert.equal(result.due_amount,'100.00');
});
test('independent receiving payment survives the purchase edit',()=>{
  const result=reconcilePurchasePayments({...base,target:{...before,paid_amount:'30.00',due_amount:'70.00'},targetPayments:[payment,{...payment,id:2,amount:'10.00',reference_no:'B'}]});
  assert.equal(result.paid_amount,'30.00');assert.equal(result.due_amount,'90.00');
});
test('missing payment, changed paid amount, overpayment and changed supplier fail closed',()=>{
  for(const change of [{targetPayments:[]},{after:{...base.after,paid_amount:'0.00'}},{after:{...base.after,grand_total:'10.00'}},{after:{...base.after,supplier_name:'Different'}}])assert.throws(()=>reconcilePurchasePayments({...base,...change}));
});
