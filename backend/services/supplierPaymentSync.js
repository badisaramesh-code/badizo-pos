const crypto=require('node:crypto');
const {enqueue}=require('./syncOutbox');
const {canonical}=require('./syncEventProtocol');
const {decimal,insert}=require('./checkoutSyncHandler');
function money(value){return (value/100n).toString()+'.'+(value%100n).toString().padStart(2,'0');}
async function captureSupplierPayment(connection,before,id,env=process.env){
  if(env.BADIZO_SYNC_PURCHASE_CAPTURE!=='true')return;
  const [[payment]]=await connection.query({sql:'SELECT * FROM supplier_payments WHERE id=?',dateStrings:true,supportBigNumbers:true,bigNumberStrings:true},[id]);
  const [[after]]=await connection.query('SELECT grand_total,paid_amount,due_amount FROM inward_entries WHERE inward_no=?',[before.inward_no]);
  if(!payment||!after)throw Error('Supplier payment capture is incomplete.');
  const identity={shopId:env.BADIZO_SHOP_ID,localInstallationId:env.BADIZO_INSTALLATION_ID,peerInstallationId:env.BADIZO_SYNC_PEER_INSTALLATION_ID};
  await enqueue(connection,{eventId:crypto.randomUUID(),shopId:identity.shopId,originInstallationId:identity.localInstallationId,type:'pos.supplier-payment.recorded',schemaVersion:1,payload:{payment:JSON.parse(JSON.stringify(payment)),before:{grand_total:before.grand_total,paid_amount:before.paid_amount,due_amount:before.due_amount},after}},identity);
}
async function applySupplierPayment(connection,payload,context){
  if(!payload||Object.keys(payload).sort().join(',')!=='after,before,payment')throw Error('Invalid supplier payment event.');
  const {payment,before,after}=payload;
  if(!payment||!/^\d+$/.test(String(payment.id))||typeof payment.inward_no!=='string'||!payment.inward_no||payment.inward_no.length>60||!before||!after)throw Error('Invalid supplier payment identity.');
  const amount=decimal(payment.amount),total=decimal(before.grand_total),paidBefore=decimal(before.paid_amount),paidAfter=decimal(after.paid_amount);
  const due=value=>value<0n?0n:value;
  if(amount<=0n||decimal(after.grand_total)!==total||paidAfter!==paidBefore+amount||decimal(before.due_amount)!==due(total-paidBefore)||decimal(after.due_amount)!==due(total-paidAfter)||paidAfter>total+1n)throw Error('Supplier payment amounts do not reconcile.');
  const hash=crypto.createHash('sha256').update(canonical(payload)).digest('hex');
  const key=[context.shopId,context.originInstallationId,String(payment.id)];
  const [mapped]=await connection.execute('SELECT payload_hash FROM sync_supplier_payment_map WHERE shop_id=? AND origin_installation_id=? AND source_payment_id=? FOR UPDATE',key);
  if(mapped.length){if(mapped[0].payload_hash!==hash)throw Error('Supplier payment identity was reused.');return;}
  const [[entry]]=await connection.query('SELECT * FROM inward_entries WHERE inward_no=? FOR UPDATE',[payment.inward_no]);
  if(!entry||entry.posting_status!=='POSTED'||decimal(entry.grand_total)!==total||entry.supplier_name!==payment.supplier_name||String(entry.supplier_gstin||'')!==String(payment.supplier_gstin||''))throw Error('Supplier payment purchase baseline differs; review required.');
  if(decimal(entry.due_amount)!==due(total-decimal(entry.paid_amount)))throw Error('Receiving supplier balance is inconsistent; review required.');
  const paid=decimal(entry.paid_amount)+amount;
  if(paid>total+1n)throw Error('Combined supplier payments exceed purchase total; review required.');
  const remaining=due(total-paid);
  const targetId=await insert(connection,'supplier_payments',payment);
  await connection.execute('UPDATE inward_entries SET paid_amount=?,due_amount=?,payment_status=? WHERE inward_no=?',[money(paid),money(remaining),remaining<=1n?'PAID':'PARTIAL',payment.inward_no]);
  await connection.execute('INSERT INTO sync_supplier_payment_map (shop_id,origin_installation_id,source_payment_id,target_payment_id,payload_hash) VALUES (?,?,?,?,?)',[...key,targetId,hash]);
}
module.exports={captureSupplierPayment,applySupplierPayment};
