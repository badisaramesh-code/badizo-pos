const test=require('node:test'),assert=require('node:assert/strict');
const {fingerprint,record,verify}=require('../services/checkoutRequestIdentity');
const actor={username:'counter1',role:'COUNTER',counter_no:1};
const intent={checkout_request_id:'request-123456',customer_name:'Customer',customer_phone:'9999999999',items:[{barcode:'A',quantity:1,sale_price:10}],grand_total:10,payment_mode:'Cash'};
test('checkout identity binds full intent and counter even when payable total matches',()=>{
  const hash=fingerprint(intent,actor);
  assert.equal(hash,fingerprint({...intent,checkout_request_id:'different-123456'},actor));
  for(const change of [{customer_name:'Different'},{customer_phone:'8888888888'},{items:[{barcode:'B',quantity:1,sale_price:10}]},{payment_mode:'UPI'},{grand_total:'10'}])assert.notEqual(hash,fingerprint({...intent,...change},actor));
  assert.notEqual(hash,fingerprint(intent,{...actor,counter_no:2}));
});
test('existing unconfigured POS does not access retry identity tables',async()=>{
  await record({},'request',null,'INV',{});await verify({},'request',null,'INV',{});
});
test('guarded duplicate needs exact retained intent and invoice proof',async()=>{
  const env={BADIZO_CHECKOUT_REQUEST_GUARD:'true'},hash=fingerprint(intent,actor);
  const db={execute:async()=>[[{intent_hash:hash,invoice_no:'INV'}]]};
  await verify(db,'request',hash,'INV',env);
  await assert.rejects(verify(db,'request','a'.repeat(64),'INV',env),error=>error.status===409);
  await assert.rejects(verify(db,'request',hash,'OTHER',env),error=>error.status===409);
  await assert.rejects(verify({execute:async()=>[[]]},'request',hash,'INV',env),error=>error.status===409);
});
