const test=require('node:test'),assert=require('node:assert/strict');
const {customerEffect}=require('../services/checkoutCustomerSync');
function payload(){return {invoice:{invoice_no:'CL/TEST',customer_phone:'+91 98765 43210',created_at:'2026-11-02 12:00:00'},loyaltyTransactions:[]};}
test('customer visit is retained even with loyalty earning disabled',()=>{
  assert.deepEqual(customerEffect(payload()),{phone:'9876543210',points:'0'});
  const walkIn=payload();walkIn.invoice.customer_phone='';assert.equal(customerEffect(walkIn),null);
});
test('earned points require a customer, the same invoice, and a positive integral amount',()=>{
  const value=payload();value.loyaltyTransactions=[{invoice_no:'CL/TEST',transaction_type:'EARN',points_delta:'5.00'}];
  assert.equal(customerEffect(value).points,'5.00');
  for(const change of [{invoice_no:'OTHER'},{transaction_type:'REDEEM'},{points_delta:'-5'},{points_delta:'1.5'}])assert.throws(()=>customerEffect({...value,loyaltyTransactions:[{...value.loyaltyTransactions[0],...change}]}));
  value.invoice.customer_phone='';assert.throws(()=>customerEffect(value));
});
