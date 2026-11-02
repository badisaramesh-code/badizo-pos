const {canonical}=require('./syncEventProtocol');
const {decimal}=require('./checkoutSyncHandler');

// Only cancels an ordinary invoice previously installed by applyCheckout.
// An older backup invoice without a trusted origin mapping requires reconciliation.
async function applyCancellation(connection,payload,context){
  if(!context?.shopId || !context.originInstallationId || payload?.change?.kind!=='void'
    || payload.invoice?.invoice_status!=='CANCELLED' || !payload.invoice.cancel_reason
    || !payload.invoice.cancelled_by || !payload.invoice.cancelled_at
    || !Array.isArray(payload.returns) || payload.returns.length
    || !Array.isArray(payload.returnItems) || payload.returnItems.length)throw Error('Unsupported cancellation event.');
  const invoiceNo=payload.invoice.invoice_no;
  const [maps]=await connection.execute('SELECT target_invoice_no,checkout_payload FROM sync_invoice_map WHERE shop_id=? AND origin_installation_id=? AND source_invoice_no=? FOR UPDATE',[context.shopId,context.originInstallationId,invoiceNo]);
  if(maps.length!==1)throw Error('Cancellation is waiting for its originating checkout.');
  const original=JSON.parse(maps[0].checkout_payload);
  const cancelledFields=['invoice_status','cancel_reason','cancelled_by','cancelled_at'];
  const restoredInvoice={...payload.invoice};
  for(const key of cancelledFields){if(Object.hasOwn(original.invoice,key))restoredInvoice[key]=original.invoice[key];else delete restoredInvoice[key];}
  const restored={invoice:restoredInvoice,items:payload.items,payments:payload.payments,batchAllocations:payload.batchAllocations,loyaltyTransactions:payload.loyaltyTransactions};
  if(canonical(restored)!==canonical(original))throw Error('Cancellation differs from the captured checkout.');
  const [invoices]=await connection.execute('SELECT invoice_status,grand_total FROM invoices WHERE invoice_no=? FOR UPDATE',[maps[0].target_invoice_no]);
  if(invoices.length!==1 || invoices[0].invoice_status!=='PAID' || decimal(invoices[0].grand_total)!==decimal(original.invoice.grand_total))throw Error('Target invoice changed; reconciliation required.');
  const [lines]=await connection.execute('SELECT i.id,i.barcode,i.quantity,i.sale_price,i.returned_qty,m.source_item_id FROM invoice_items i JOIN sync_invoice_item_map m ON m.target_item_id=i.id WHERE m.shop_id=? AND m.origin_installation_id=? AND m.source_invoice_no=? AND i.invoice_no=? FOR UPDATE',[context.shopId,context.originInstallationId,invoiceNo,maps[0].target_invoice_no]);
  if(lines.length!==original.items.length)throw Error('Target invoice lines changed.');
  const quantities=new Map();
  for(const source of original.items){
    const line=lines.find(row=>String(row.source_item_id)===String(source.id));
    if(!line || line.barcode!==source.barcode || decimal(line.quantity)!==decimal(source.quantity) || decimal(line.sale_price)!==decimal(source.sale_price) || decimal(line.returned_qty)!==0n)throw Error('Target invoice line changed.');
    quantities.set(line.barcode,(quantities.get(line.barcode)||0n)+decimal(line.quantity));
  }
  for(const barcode of [...quantities.keys()].sort()){
    const [products]=await connection.execute('SELECT barcode FROM products WHERE barcode=? FOR UPDATE',[barcode]);
    if(products.length!==1)throw Error('Cancellation product missing.');
    const quantity=quantities.get(barcode);
    await connection.execute('UPDATE products SET stock_qty=stock_qty+?,updated_at=CURRENT_TIMESTAMP WHERE barcode=?',[(quantity/100n)+'.'+String(quantity%100n).padStart(2,'0'),barcode]);
  }
  await connection.execute("UPDATE invoices SET invoice_status='CANCELLED',cancel_reason=?,cancelled_by=?,cancelled_at=? WHERE invoice_no=?",[payload.invoice.cancel_reason,payload.invoice.cancelled_by,payload.invoice.cancelled_at,maps[0].target_invoice_no]);
}
module.exports={applyCancellation};
