const {customerEffect,applyCustomerEffect}=require('./checkoutCustomerSync');
function decimal(value){
  const text=String(value);
  if(!/^\d{1,8}(\.\d{1,2})?$/.test(text))throw Error('Unsupported decimal in invoice event.');
  const [whole,fraction='']=text.split('.');return BigInt(whole)*100n+BigInt(fraction.padEnd(2,'0'));
}
async function insert(connection,table,row){
  const [schema]=await connection.query('SHOW COLUMNS FROM `'+table+'`');
  const allowed=new Set(schema.map(column=>column.Field));
  const keys=Object.keys(row).filter(key=>key!=='id');
  if(!keys.length || keys.some(key=>!allowed.has(key) || !/^[a-z_]+$/.test(key)))throw Error('Source and target invoice schemas differ.');
  const values=keys.map(key=>{const value=row[key];if(value!==null && !['string','number','boolean'].includes(typeof value))throw Error('Unexpected invoice field value.');return value;});
  const [result]=await connection.execute('INSERT INTO `'+table+'` ('+keys.map(key=>'`'+key+'`').join(',')+') VALUES ('+keys.map(()=>'?').join(',')+')',values);
  return result.insertId;
}
// Strict first application profile: ordinary invoices without batch allocation,
// exchanges, promotions or loyalty redemption. Unsupported cases remain pending.
async function applyCheckout(connection,payload,context){
  if(!payload || Object.keys(payload).some(key=>!['invoice','items','payments','batchAllocations','loyaltyTransactions'].includes(key)))throw Error('Invalid checkout event.');
  const {invoice,items,payments,batchAllocations,loyaltyTransactions}=payload;
  if(!invoice || typeof invoice.invoice_no!=='string' || !invoice.invoice_no || invoice.invoice_no.length>50
    || !Array.isArray(items) || !items.length || items.length>500 || !Array.isArray(payments)
    || !Array.isArray(batchAllocations) || batchAllocations.length || !Array.isArray(loyaltyTransactions)
    || Number(invoice.exchange_total)!==0 || invoice.exchange_items_json!==null
    || Number(invoice.loyalty_redeemed_points)!==0 || Number(invoice.loyalty_redeemed_amount)!==0
    || invoice.invoice_status!=='PAID')throw Error('Checkout requires a different application profile.');
  const quantities=new Map();let gross=0n,paid=0n;
  for(const item of items){
    if(item.invoice_no!==invoice.invoice_no || typeof item.barcode!=='string' || !item.barcode || item.barcode.length>120
      || Number(item.is_free_bonus)!==0 || item.free_offer_id!==null || Number(item.returned_qty)!==0)throw Error('Unsupported invoice item.');
    const quantity=decimal(item.quantity);if(quantity<=0n)throw Error('Invalid quantity.');
    quantities.set(item.barcode,(quantities.get(item.barcode)||0n)+quantity);
    gross+=quantity*decimal(item.sale_price);
  }
  for(const payment of payments){
    if(payment.invoice_no!==invoice.invoice_no || !['Cash','UPI','Card'].includes(payment.payment_mode))throw Error('Invalid invoice payment.');
    paid+=decimal(payment.amount);
  }
  const total=decimal(invoice.grand_total);
  // Source checkout rounds currency to paise, then the payable total to a
  // whole rupee. Compare exactly, without floating-point rounding drift.
  if(((gross+50n)/100n+50n)/100n*100n!==total || paid!==total)throw Error('Invoice totals do not reconcile.');
  const customer=customerEffect(payload);
  if(!context || !context.shopId || !context.originInstallationId)throw Error('Authenticated invoice origin required.');
  const sourceIds=items.map(item=>String(item.id));
  if(sourceIds.some(id=>! /^[1-9][0-9]{0,15}$/.test(id)) || new Set(sourceIds).size!==items.length)throw Error('Invalid source invoice line identities.');
  // Match products explicitly and lock in stable order. Never manufacture a
  // missing product or overwrite its name/price with an old receipt value.
  for(const barcode of [...quantities.keys()].sort()){
    const [products]=await connection.execute('SELECT barcode,free_promo_enabled FROM products WHERE barcode=? FOR UPDATE',[barcode]);
    if(products.length!==1 || Number(products[0].free_promo_enabled)!==0)throw Error('Product missing or promotion reconciliation required.');
    const [batches]=await connection.execute('SELECT id FROM product_batches WHERE barcode=? AND quantity_available>0 FOR UPDATE',[barcode]);
    if(batches.length)throw Error('Target batch inventory requires allocation reconciliation.');
  }
  await insert(connection,'invoices',invoice);
  await connection.execute('INSERT INTO sync_invoice_map (shop_id,origin_installation_id,source_invoice_no,target_invoice_no,checkout_payload) VALUES (?,?,?,?,?)',[context.shopId,context.originInstallationId,invoice.invoice_no,invoice.invoice_no,JSON.stringify(payload)]);
  for(const item of items){
    const targetId=await insert(connection,'invoice_items',item);
    await connection.execute('INSERT INTO sync_invoice_item_map (shop_id,origin_installation_id,source_invoice_no,source_item_id,target_item_id) VALUES (?,?,?,?,?)',[context.shopId,context.originInstallationId,invoice.invoice_no,String(item.id),targetId]);
  }
  for(const payment of payments)await insert(connection,'invoice_payments',payment);
  await applyCustomerEffect(connection,payload,customer,insert);
  for(const [barcode,quantity] of quantities){
    const value=(quantity/100n).toString()+'.'+(quantity%100n).toString().padStart(2,'0');
    await connection.execute('UPDATE products SET stock_qty=stock_qty-? WHERE barcode=?',[value,barcode]);
  }
}
module.exports={applyCheckout,decimal,insert};
