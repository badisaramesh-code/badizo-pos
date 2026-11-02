const {canonical}=require('./syncEventProtocol');
const {decimal,insert}=require('./checkoutSyncHandler');
function money(value){return (value/100n)+'.'+String(value%100n).padStart(2,'0');}

// Ordinary invoice profile only. Requires checkout origin mapping and all earlier
// returns. No source numeric ID is ever used as a receiver invoice item ID.
async function applyReturn(connection,payload,context){
  if(!context?.shopId || !context.originInstallationId || payload?.change?.kind!=='return'
    || !payload.change.returnNo || !['RETURNED','PARTIALLY_RETURNED'].includes(payload.invoice?.invoice_status)
    || !Array.isArray(payload.returns) || !Array.isArray(payload.returnItems)
    || !Array.isArray(payload.items))throw Error('Unsupported return event.');
  const invoiceNo=payload.invoice.invoice_no,returnNo=payload.change.returnNo;
  const [maps]=await connection.execute('SELECT target_invoice_no,checkout_payload FROM sync_invoice_map WHERE shop_id=? AND origin_installation_id=? AND source_invoice_no=? FOR UPDATE',[context.shopId,context.originInstallationId,invoiceNo]);
  if(maps.length!==1)throw Error('Return is waiting for its originating checkout.');
  const original=JSON.parse(maps[0].checkout_payload);
  const restored={invoice:{...payload.invoice,invoice_status:original.invoice.invoice_status},items:payload.items.map(item=>{
    const before=original.items.find(row=>String(row.id)===String(item.id));
    if(!before)throw Error('Unknown returned line.');
    return {...item,returned_qty:before.returned_qty};
  }),payments:payload.payments,batchAllocations:payload.batchAllocations,loyaltyTransactions:payload.loyaltyTransactions};
  if(canonical(restored)!==canonical(original))throw Error('Return differs from the captured checkout.');
  const headers=payload.returns;
  if(new Set(headers.map(row=>row.return_no)).size!==headers.length || headers.some(row=>row.invoice_no!==invoiceNo))throw Error('Invalid return history.');
  const current=headers.find(row=>row.return_no===returnNo);
  if(!current || !['Cash','UPI','Card'].includes(current.refund_mode))throw Error('Invalid return header.');
  const currentLines=payload.returnItems.filter(row=>row.return_no===returnNo);
  if(!currentLines.length || new Set(currentLines.map(row=>String(row.invoice_item_id))).size!==currentLines.length)throw Error('Invalid return lines.');
  const [invoices]=await connection.execute('SELECT invoice_status,grand_total FROM invoices WHERE invoice_no=? FOR UPDATE',[maps[0].target_invoice_no]);
  if(invoices.length!==1 || !['PAID','PARTIALLY_RETURNED'].includes(invoices[0].invoice_status) || decimal(invoices[0].grand_total)!==decimal(original.invoice.grand_total))throw Error('Target invoice changed; reconciliation required.');
  const [previous]=await connection.execute('SELECT return_no FROM sales_returns WHERE invoice_no=? FOR UPDATE',[maps[0].target_invoice_no]);
  const expectedPrevious=headers.filter(row=>row.return_no!==returnNo).map(row=>row.return_no).sort();
  if(canonical(previous.map(row=>row.return_no).sort())!==canonical(expectedPrevious))throw Error('Return history is out of order or changed.');
  const [lines]=await connection.execute('SELECT i.id,i.barcode,i.quantity,i.sale_price,i.returned_qty,m.source_item_id FROM invoice_items i JOIN sync_invoice_item_map m ON m.target_item_id=i.id WHERE m.shop_id=? AND m.origin_installation_id=? AND m.source_invoice_no=? AND i.invoice_no=? FOR UPDATE',[context.shopId,context.originInstallationId,invoiceNo,maps[0].target_invoice_no]);
  if(lines.length!==original.items.length)throw Error('Target invoice lines changed.');
  const quantities=new Map();let total=0n,taxableTotal=0n,gstTotal=0n,fullyReturned=true;
  for(const source of original.items){
    const line=lines.find(row=>String(row.source_item_id)===String(source.id));
    const snapshot=payload.items.find(row=>String(row.id)===String(source.id));
    if(!line || line.barcode!==source.barcode || decimal(line.quantity)!==decimal(source.quantity) || decimal(line.sale_price)!==decimal(source.sale_price))throw Error('Target invoice line changed.');
    const returning=currentLines.find(row=>String(row.invoice_item_id)===String(source.id));
    const quantity=returning?decimal(returning.quantity):0n;
    const cumulative=decimal(line.returned_qty)+quantity;
    if(cumulative!==decimal(snapshot.returned_qty) || cumulative>decimal(source.quantity))throw Error('Return quantity is out of order or exceeds sold quantity.');
    if(cumulative<decimal(source.quantity))fullyReturned=false;
    if(returning){
      if(quantity<=0n || returning.barcode!==source.barcode || decimal(returning.sale_price)!==decimal(source.sale_price)
        || decimal(returning.gst_percent)!==decimal(source.gst_percent))throw Error('Return does not match sold line.');
      const refund=(quantity*decimal(source.sale_price)+50n)/100n;
      if(decimal(returning.refund_amount)!==refund)throw Error('Return refund does not reconcile.');
      const denominator=10000n+decimal(source.gst_percent);
      const taxable=(refund*10000n+denominator/2n)/denominator;
      if(decimal(returning.taxable_amount)!==taxable || decimal(returning.gst_amount)!==refund-taxable)throw Error('Return tax requires rounding reconciliation.');
      taxableTotal+=taxable;gstTotal+=refund-taxable;
      total+=refund;quantities.set(line.barcode,(quantities.get(line.barcode)||0n)+quantity);
    }
  }
  if(currentLines.some(row=>!original.items.some(item=>String(item.id)===String(row.invoice_item_id)))
    || total!==decimal(current.refund_total) || total<=0n || taxableTotal!==decimal(current.taxable_total) || gstTotal!==decimal(current.gst_total)
    || payload.invoice.invoice_status!==(fullyReturned?'RETURNED':'PARTIALLY_RETURNED'))throw Error('Return totals or status do not reconcile.');
  for(const barcode of [...quantities.keys()].sort()){
    const [products]=await connection.execute('SELECT barcode FROM products WHERE barcode=? FOR UPDATE',[barcode]);
    if(products.length!==1)throw Error('Return product missing.');
  }
  await insert(connection,'sales_returns',{...current,invoice_no:maps[0].target_invoice_no});
  for(const returning of currentLines){
    const target=lines.find(row=>String(row.source_item_id)===String(returning.invoice_item_id));
    await insert(connection,'sales_return_items',{...returning,invoice_item_id:target.id});
    await connection.execute('UPDATE invoice_items SET returned_qty=returned_qty+? WHERE id=?',[returning.quantity,target.id]);
  }
  for(const [barcode,quantity] of quantities)await connection.execute('UPDATE products SET stock_qty=stock_qty+?,updated_at=CURRENT_TIMESTAMP WHERE barcode=?',[money(quantity),barcode]);
  await connection.execute('UPDATE invoices SET invoice_status=? WHERE invoice_no=?',[payload.invoice.invoice_status,maps[0].target_invoice_no]);
}
module.exports={applyReturn};
