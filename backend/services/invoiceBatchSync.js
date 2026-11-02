const {quantity,format}=require('./stockAdjustmentSync');
const {canonical}=require('./syncEventProtocol');
const identityArgs=(context,invoiceNo)=>[context.shopId,context.originInstallationId,invoiceNo];
function batchKey(row){return JSON.stringify([row.barcode,row.batch_no,row.expiry_date]);}
function validateAllocations(payload){
  const seen=new Set(),totals=new Map();
  for(const row of payload.batchAllocations){
    const item=payload.items.find(item=>String(item.id)===String(row.invoice_item_id));
    if(!/^[1-9][0-9]{0,18}$/.test(String(row.id))||seen.has(String(row.id))||!item||row.invoice_no!==payload.invoice.invoice_no
      ||row.barcode!==item.barcode||typeof row.batch_no!=='string'||row.batch_no.length>80
      ||(row.expiry_date!==null&&!/^\d{4}-\d{2}-\d{2}$/.test(row.expiry_date))
      ||quantity(row.quantity)<=0n||quantity(row.returned_qty)!==0n)throw Error('Invalid source batch allocation.');
    seen.add(String(row.id));totals.set(String(item.id),(totals.get(String(item.id))||0n)+quantity(row.quantity));
    if(totals.get(String(item.id))>quantity(item.quantity))throw Error('Batch allocation exceeds sold quantity.');
  }
}
async function applyCheckoutBatches(connection,payload,context,itemIds,insert){
  const groups=new Map();
  for(const row of payload.batchAllocations){const key=batchKey(row);if(!groups.has(key))groups.set(key,{row,amount:0n});groups.get(key).amount+=quantity(row.quantity);}
  const targetBatches=new Map();
  for(const key of [...groups.keys()].sort()){
    const {row,amount}=groups.get(key);
    const [batches]=await connection.execute('SELECT id,quantity_available FROM product_batches WHERE barcode=? AND batch_no=? AND expiry_date <=> ? FOR UPDATE',[row.barcode,row.batch_no,row.expiry_date]);
    if(batches.length!==1)throw Error('Batch identity is missing or ambiguous.');
    if(quantity(batches[0].quantity_available)<amount)throw Error('Insufficient receiving batch stock; reconciliation required.');
    targetBatches.set(key,batches[0].id);
    await connection.execute('UPDATE product_batches SET quantity_available=quantity_available-? WHERE id=?',[format(amount),batches[0].id]);
  }
  for(const row of payload.batchAllocations){
    const targetItem=itemIds.get(String(row.invoice_item_id));if(!targetItem)throw Error('Batch invoice line mapping missing.');
    const targetId=await insert(connection,'invoice_item_batches',{...row,invoice_item_id:targetItem});
    await connection.execute('INSERT INTO sync_invoice_batch_map (shop_id,origin_installation_id,source_invoice_no,source_allocation_id,target_allocation_id,target_batch_id) VALUES (?,?,?,?,?,?)',[...identityArgs(context,payload.invoice.invoice_no),String(row.id),targetId,targetBatches.get(batchKey(row))]);
  }
}
function originalBatchShape(original,payload){
  if(!Array.isArray(payload.batchAllocations)||payload.batchAllocations.length!==original.batchAllocations.length)throw Error('Batch allocation history changed.');
  return payload.batchAllocations.map(row=>{
    const previous=original.batchAllocations.find(item=>String(item.id)===String(row.id));
    if(!previous||quantity(row.returned_qty)<0n||quantity(row.returned_qty)>quantity(row.quantity))throw Error('Invalid returned batch quantity.');
    const restored={...row,returned_qty:previous.returned_qty};
    if(canonical(restored)!==canonical(previous))throw Error('Batch allocation changed since checkout.');
    return restored;
  });
}
async function restoreInvoiceBatches(connection,original,payload,context,returnQuantities){
  if(!original.batchAllocations.length)return;
  const [mappings]=await connection.query({sql:'SELECT m.source_allocation_id,m.target_batch_id,a.* FROM sync_invoice_batch_map m JOIN invoice_item_batches a ON a.id=m.target_allocation_id WHERE m.shop_id=? AND m.origin_installation_id=? AND m.source_invoice_no=? FOR UPDATE',dateStrings:true,supportBigNumbers:true,bigNumberStrings:true},identityArgs(context,original.invoice.invoice_no));
  if(mappings.length!==original.batchAllocations.length)throw Error('Batch allocation mapping missing.');
  const remaining=new Map(returnQuantities),changes=[];
  const ordered=[...original.batchAllocations].sort((a,b)=>BigInt(a.id)>BigInt(b.id)?-1:1);
  for(const source of ordered){
    const target=mappings.find(row=>String(row.source_allocation_id)===String(source.id));
    const incoming=payload.batchAllocations.find(row=>String(row.id)===String(source.id));
    if(!target||batchKey(target)!==batchKey(source)||quantity(target.quantity)!==quantity(source.quantity))throw Error('Receiving batch allocation changed.');
    const prior=quantity(target.returned_qty),available=quantity(source.quantity)-prior;
    if(available<0n)throw Error('Receiving batch return exceeds allocation.');
    const requested=remaining.get(String(source.invoice_item_id))||0n,delta=requested<available?requested:available;
    if(quantity(incoming.returned_qty)!==prior+delta)throw Error('Batch returns are out of order or inconsistent.');
    remaining.set(String(source.invoice_item_id),requested-delta);
    if(delta>0n)changes.push({source,target,delta});
  }
  for(const change of changes.sort((a,b)=>String(a.target.target_batch_id).localeCompare(String(b.target.target_batch_id)))){
    const {source,target,delta}=change;
    const [batches]=await connection.query({sql:'SELECT id,barcode,batch_no,expiry_date FROM product_batches WHERE id=? FOR UPDATE',dateStrings:true},[target.target_batch_id]);
    // DATE strings are requested explicitly to avoid timezone conversion.
    if(batches.length!==1||batchKey(batches[0])!==batchKey(source))throw Error('Receiving product batch changed.');
    await connection.execute('UPDATE product_batches SET quantity_available=quantity_available+? WHERE id=?',[format(delta),target.target_batch_id]);
    await connection.execute('UPDATE invoice_item_batches SET returned_qty=returned_qty+? WHERE id=?',[format(delta),target.id]);
  }
}
module.exports={validateAllocations,applyCheckoutBatches,originalBatchShape,restoreInvoiceBatches};
