const {quantity,format}=require('./stockAdjustmentSync');
const {canonical}=require('./syncEventProtocol');
const key=row=>JSON.stringify([row.barcode,row.batch_no,row.expiry_date]);
const ignored=new Set(['id','created_at','updated_at','previous_updated_at']);
function metadata(before,after,current,quantities){
  const result={...current};
  for(const field of Object.keys(after)){
    if(ignored.has(field)||quantities.includes(field))continue;
    if(canonical(before[field]??null)===canonical(after[field]??null))continue;
    if(canonical(current[field]??null)!==canonical(before[field]??null))throw Error('Purchase inventory metadata conflicts; review required.');
    result[field]=after[field];
  }
  for(const field of quantities){
    const value=quantity(current[field])+quantity(after[field])-quantity(before[field]);
    if(value<0n)throw Error('Purchase edit would remove stock already sold; review required.');
    result[field]=format(value);
  }
  return result;
}
function unique(rows,identify){if(new Set(rows.map(identify)).size!==rows.length)throw Error('Ambiguous purchase inventory identity.');}
function reconcilePurchaseInventory(before,after,current){
  for(const state of [before,after,current]){
    if(!Array.isArray(state?.products)||!Array.isArray(state?.batches))throw Error('Purchase inventory snapshots required.');
    unique(state.products,row=>row.barcode);unique(state.batches,key);
  }
  if(before.products.some(row=>!after.products.some(next=>next.barcode===row.barcode)))throw Error('Purchase edit cannot delete product masters.');
  const products=after.products.map(next=>{
    const previous=before.products.find(row=>row.barcode===next.barcode),target=current.products.find(row=>row.barcode===next.barcode);
    if(!previous){if(target)throw Error('New purchase product conflicts with receiver.');if(quantity(next.stock_qty)<0n)throw Error('Negative new stock.');return next;}
    if(!target)throw Error('Receiving product is missing.');
    return metadata(previous,next,target,['stock_qty']);
  });
  // Receiving-only batches belong to independent activity and are retained.
  const batches=current.batches.filter(row=>!before.batches.some(old=>key(old)===key(row))&&!after.batches.some(next=>key(next)===key(row)));
  for(const previous of before.batches){
    if(after.batches.some(row=>key(row)===key(previous)))continue;
    const target=current.batches.find(row=>key(row)===key(previous));
    if(!target)throw Error('Receiving batch is missing before deletion.');
    const clean=row=>Object.fromEntries(Object.entries(row).filter(([field])=>!ignored.has(field)));
    if(canonical(clean(previous))!==canonical(clean(target))||quantity(target.quantity_available)!==quantity(target.quantity_received))throw Error('Cannot remove a batch sold or changed on receiver.');
  }
  for(const next of after.batches){
    const previous=before.batches.find(row=>key(row)===key(next)),target=current.batches.find(row=>key(row)===key(next));
    let merged;
    if(!previous){if(target)throw Error('New purchase batch conflicts with receiver.');merged=next;}
    else{if(!target)throw Error('Receiving batch is missing.');merged=metadata(previous,next,target,['quantity_received','quantity_available']);}
    if(quantity(merged.quantity_available)<0n||quantity(merged.quantity_received)<quantity(merged.quantity_available))throw Error('Merged purchase batch quantities are inconsistent.');
    batches.push(merged);
  }
  return {products,batches};
}
module.exports={reconcilePurchaseInventory};
