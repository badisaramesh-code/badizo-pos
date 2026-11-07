const {quantity,format}=require('./stockAdjustmentSync');
const {canonical}=require('./syncEventProtocol');
const paymentKey=row=>canonical(Object.fromEntries(Object.entries(row).filter(([key])=>!['id','created_at','updated_at'].includes(key))));
function reconcilePurchasePayments({before,after,sourcePayments,target,targetPayments}){
  if(!Array.isArray(sourcePayments)||!Array.isArray(targetPayments))throw Error('Purchase payment history is required.');
  for(const field of ['supplier_name','supplier_gstin']){
    if(String(before[field]||'')!==String(after[field]||'')||String(before[field]||'')!==String(target[field]||''))throw Error('Paid purchase supplier identity requires review.');
  }
  if(quantity(after.paid_amount)!==quantity(before.paid_amount))throw Error('Record payment changes separately from purchase edits.');
  let sourcePaid=0n;
  for(const payment of sourcePayments){
    const amount=quantity(payment.amount);
    if(amount<=0n||payment.inward_no!==before.inward_no)throw Error('Invalid source supplier payment.');
    sourcePaid+=amount;
  }
  if(sourcePaid>quantity(before.paid_amount))throw Error('Source payment history exceeds the recorded balance.');
  const remaining=targetPayments.slice();
  for(const payment of sourcePayments){
    const index=remaining.findIndex(row=>paymentKey(row)===paymentKey(payment));
    if(index<0)throw Error('Purchase payment history is missing or changed; synchronize payments first.');
    remaining.splice(index,1);
  }
  let extra=0n;
  for(const payment of remaining){const amount=quantity(payment.amount);if(amount<=0n||payment.inward_no!==before.inward_no)throw Error('Invalid additional supplier payment.');extra+=amount;}
  const paid=quantity(before.paid_amount)+extra,total=quantity(after.grand_total);
  if(paid<0n||paid!==quantity(target.paid_amount)||paid>total)throw Error('Purchase edit conflicts with recorded payments; refund or adjustment required.');
  const oldDue=quantity(target.grand_total)-paid;
  if(quantity(target.due_amount)!==(oldDue<0n?0n:oldDue))throw Error('Receiving supplier balance is inconsistent.');
  const due=total-paid;
  return {...after,paid_amount:format(paid),due_amount:format(due),payment_status:due===0n?'PAID':paid>0n?'PARTIAL':after.payment_status};
}
module.exports={reconcilePurchasePayments};
