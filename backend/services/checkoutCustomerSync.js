const {normalizePhone}=require('../utils/formatters');

function customerEffect(payload){
  const phone=normalizePhone(payload.invoice.customer_phone);
  const transactions=payload.loyaltyTransactions;
  if(!Array.isArray(transactions)||transactions.length>1)throw Error('Unsupported loyalty history.');
  if(phone.length!==10){if(transactions.length)throw Error('Loyalty event has no customer identity.');return null;}
  let points='0';
  for(const transaction of transactions){
    if(transaction.invoice_no!==payload.invoice.invoice_no || transaction.transaction_type!=='EARN'
      || !/^[1-9][0-9]{0,7}(\.00)?$/.test(String(transaction.points_delta)))throw Error('Loyalty earning requires reconciliation.');
    points=String(transaction.points_delta);
  }
  if(typeof payload.invoice.created_at!=='string' || !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d{1,6})?$/.test(payload.invoice.created_at))throw Error('Customer visit requires source invoice time.');
  return {phone,points};
}

async function applyCustomerEffect(connection,payload,effect,insert){
  if(!effect)return;
  // Add only the sale's effects, never copy the source customer's accumulated
  // balance over the target. Existing contact details remain unchanged.
  await connection.execute(`INSERT INTO customers (customer_name,phone,loyalty_points,total_spent,visit_count,last_visit_at)
    VALUES (?,?,?,?,1,?) ON DUPLICATE KEY UPDATE loyalty_points=loyalty_points+VALUES(loyalty_points),
    total_spent=total_spent+VALUES(total_spent),visit_count=visit_count+1,
    last_visit_at=GREATEST(COALESCE(last_visit_at,VALUES(last_visit_at)),VALUES(last_visit_at))`,
    [payload.invoice.customer_name||'Walk-in Customer',effect.phone,effect.points,payload.invoice.grand_total,payload.invoice.created_at]);
  const [[customer]]=await connection.execute('SELECT id FROM customers WHERE phone=? FOR UPDATE',[effect.phone]);
  if(!customer)throw Error('Customer mapping failed.');
  for(const transaction of payload.loyaltyTransactions)await insert(connection,'loyalty_transactions',{...transaction,customer_id:customer.id});
}
module.exports={customerEffect,applyCustomerEffect};
