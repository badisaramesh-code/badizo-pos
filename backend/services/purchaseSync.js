const crypto=require('node:crypto');
const {enqueue}=require('./syncOutbox');
const {quantity,format}=require('./stockAdjustmentSync');
const {insert}=require('./checkoutSyncHandler');
const {canonical}=require('./syncEventProtocol');
const {reconcilePurchasePayments}=require('./purchasePaymentReconciliation');
const {reconcilePurchaseInventory}=require('./purchaseInventoryReconciliation');
async function rows(connection,sql,args=[]){const [result]=await connection.query({sql,dateStrings:true,supportBigNumbers:true,bigNumberStrings:true},args);return JSON.parse(JSON.stringify(result));}
async function inventory(connection,barcodes,lock=false){
  if(!barcodes.length)return {products:[],batches:[]};
  const marks=barcodes.map(()=>'?').join(','),suffix=lock?' FOR UPDATE':'';
  return {products:await rows(connection,`SELECT * FROM products WHERE barcode IN (${marks}) ORDER BY barcode${suffix}`,barcodes),batches:await rows(connection,`SELECT * FROM product_batches WHERE barcode IN (${marks}) ORDER BY id${suffix}`,barcodes)};
}
async function beginPurchaseCapture(connection,barcodes,operation,env=process.env,referenceId=null){
  if(env.BADIZO_SYNC_PURCHASE_CAPTURE!=='true')return null;
  const entries=referenceId?await rows(connection,'SELECT * FROM inward_entries WHERE id=? FOR UPDATE',[referenceId]):[];
  const items=entries.length?await rows(connection,'SELECT * FROM inward_items WHERE inward_no=? ORDER BY id',[entries[0].inward_no]):[];
  const payments=entries.length?await rows(connection,'SELECT * FROM supplier_payments WHERE inward_no=? ORDER BY id',[entries[0].inward_no]):[];
  const codes=[...new Set([...barcodes,...items.map(row=>row.barcode)])].sort();
  return {barcodes:codes,operation,before:{...await inventory(connection,codes,true),entry:entries[0]||null,items,payments}};
}
async function finishPurchaseCapture(connection,start,inwardNo,env=process.env){
  if(!start)return;
  const headers=await rows(connection,'SELECT * FROM inward_entries WHERE inward_no=?',[inwardNo]);
  const payload={operation:start.operation,entry:headers[0]||null,inwardNo,items:await rows(connection,'SELECT * FROM inward_items WHERE inward_no=? ORDER BY id',[inwardNo]),before:start.before,after:await inventory(connection,start.barcodes)};
  if(start.operation==='draft-posting'&&start.before.entry){
    const previousNo=start.before.entry.inward_no;
    const previous=await rows(connection,'SELECT * FROM inward_entries WHERE inward_no=?',[previousNo]);
    payload.remainingDraft={entry:previous[0]||null,items:await rows(connection,'SELECT * FROM inward_items WHERE inward_no=? ORDER BY id',[previousNo])};
  }
  const identity={shopId:env.BADIZO_SHOP_ID,localInstallationId:env.BADIZO_INSTALLATION_ID,peerInstallationId:env.BADIZO_SYNC_PEER_INSTALLATION_ID};
  await enqueue(connection,{eventId:crypto.randomUUID(),shopId:identity.shopId,originInstallationId:identity.localInstallationId,type:'pos.purchase.changed',schemaVersion:1,payload},identity);
}
const batchKey=row=>JSON.stringify([row.barcode,row.batch_no,row.expiry_date]);
function matchesRoundedSum(sum,total,count){const difference=sum-total;return (difference<0n?-difference:difference)<=BigInt(Math.floor((count+1)/2));}
async function applyPurchase(connection,payload){
  if(payload?.operation==='delete')return applyPurchaseDeletion(connection,payload);
  if(payload?.operation==='replace')return applyPurchaseReplacement(connection,payload);
  if(payload?.operation==='draft-posting')return applyDraftPosting(connection,payload);
  if(!payload||payload.operation!=='create'||!payload.entry||payload.entry.inward_no!==payload.inwardNo
    ||!['POSTED','DRAFT'].includes(payload.entry.posting_status)||!Array.isArray(payload.items)||!payload.items.length
    ||!Array.isArray(payload.before?.products)||!Array.isArray(payload.after?.products)||!Array.isArray(payload.before?.batches)||!Array.isArray(payload.after?.batches)
    ||payload.items.some(row=>row.inward_no!==payload.inwardNo||Number(row.free_offer_enabled)!==0))throw Error('Purchase requires a different reconciliation profile.');
  const entry=payload.entry;
  if(Number(entry.item_count)!==payload.items.length)throw Error('Purchase item count does not reconcile.');
  let lineTotal=0n;for(const row of payload.items)lineTotal+=quantity(row.total_amount);
  if(!matchesRoundedSum(lineTotal,quantity(entry.grand_total),payload.items.length)
    ||!matchesRoundedSum(quantity(entry.paid_amount)+quantity(entry.due_amount),entry.posting_status==='DRAFT'?0n:quantity(entry.grand_total),2))throw Error('Purchase amounts require reconciliation.');
  const [existing]=await connection.execute('SELECT id FROM inward_entries WHERE inward_no=? FOR UPDATE',[payload.inwardNo]);
  if(existing.length)throw Error('Purchase number already exists; review required.');
  const effects=new Map();let stockTotal=0n;
  for(const after of payload.after.products){
    if(effects.has(after.barcode))throw Error('Invalid purchase product identity.');
    const before=payload.before.products.find(row=>row.barcode===after.barcode);
    if(!payload.items.some(row=>row.barcode===after.barcode)){
      if(!before||canonical(comparable(before))!==canonical(comparable(after)))throw Error('Unrelated purchase product changed.');
      continue;
    }
    const delta=quantity(after.stock_qty)-(before?quantity(before.stock_qty):0n);
    if(delta<0n)throw Error('New purchase cannot remove stock.');
    effects.set(after.barcode,{before,after,delta});stockTotal+=delta;
  }
  if(!matchesRoundedSum(stockTotal,quantity(entry.total_qty),payload.items.length))throw Error('Purchase stock does not reconcile.');
  const batchEffects=[];const batchTotals=new Map();
  for(const after of payload.after.batches){
    const before=payload.before.batches.find(row=>String(row.id)===String(after.id));
    if(before&&batchKey(before)!==batchKey(after))throw Error('Purchase changed a batch identity.');
    const delta=quantity(after.quantity_received)-(before?quantity(before.quantity_received):0n);
    if(delta===0n)continue;
    if(delta<0n||quantity(after.quantity_available)-(before?quantity(before.quantity_available):0n)!==delta||after.inward_no!==payload.inwardNo)throw Error('Purchase batch delta is inconsistent.');
    batchEffects.push({before,after,delta});batchTotals.set(after.barcode,(batchTotals.get(after.barcode)||0n)+delta);
  }
  for(const [barcode,effect] of effects)if((batchTotals.get(barcode)||0n)!==effect.delta)throw Error('Purchase batch and total stock disagree.');
  for(const [barcode,{before,after,delta}] of [...effects].sort(([a],[b])=>a.localeCompare(b))){
    const targets=await rows(connection,'SELECT * FROM products WHERE barcode=? FOR UPDATE',[barcode]);
    if(!before){if(targets.length)throw Error('New purchase product conflicts with an existing product.');await insert(connection,'products',{...after,stock_qty:'0.00'});}
    else{
      if(targets.length!==1)throw Error('Purchase product baseline missing.');
      for(const field of ['product_name','hsn_code','gst_percent','purchase_price']){
        if(String(before[field])===String(after[field]))continue;
        if(String(targets[0][field])!==String(before[field]))throw Error('Purchase product fields conflict; review required.');
        await connection.execute('UPDATE products SET `'+field+'`=? WHERE barcode=?',[after[field],barcode]);
      }
    }
    if(delta>0n)await connection.execute('UPDATE products SET stock_qty=stock_qty+?,updated_at=CURRENT_TIMESTAMP WHERE barcode=?',[format(delta),barcode]);
  }
  await insert(connection,'inward_entries',entry);
  for(const item of payload.items)await insert(connection,'inward_items',item);
  for(const {before,after,delta} of batchEffects){
    const targets=await rows(connection,'SELECT * FROM product_batches WHERE barcode=? AND batch_no=? AND expiry_date <=> ? FOR UPDATE',[after.barcode,after.batch_no,after.expiry_date]);
    if(!before){if(targets.length)throw Error('New purchase batch conflicts with existing inventory.');await insert(connection,'product_batches',after);}
    else{
      if(targets.length!==1)throw Error('Purchase batch baseline missing or ambiguous.');
      for(const field of ['purchase_price','mrp'])if(String(targets[0][field])!==String(before[field]))throw Error('Purchase batch metadata conflicts.');
      await connection.execute('UPDATE product_batches SET quantity_received=quantity_received+?,quantity_available=quantity_available+?,purchase_price=?,mrp=?,inward_no=? WHERE id=?',[format(delta),format(delta),after.purchase_price,after.mrp,payload.inwardNo,targets[0].id]);
    }
  }
}
function comparable(row){return Object.fromEntries(Object.entries(row).filter(([key])=>!['id','created_at','updated_at','previous_updated_at'].includes(key)));}
async function applyDraftPosting(connection,payload){
  const previous=payload.before?.entry,remaining=payload.remainingDraft;
  if(!previous||previous.posting_status!=='DRAFT'||previous.inward_no===payload.inwardNo||!remaining||!Array.isArray(remaining.items)
    ||!Array.isArray(payload.before.items)||payload.before.payments?.length)throw Error('Invalid draft-posting baseline.');
  const targets=await rows(connection,'SELECT * FROM inward_entries WHERE inward_no=? FOR UPDATE',[previous.inward_no]);
  if(targets.length!==1||canonical(comparable(targets[0]))!==canonical(comparable(previous)))throw Error('Receiving draft changed; review required.');
  const lines=await rows(connection,'SELECT * FROM inward_items WHERE inward_no=? ORDER BY id FOR UPDATE',[previous.inward_no]);
  if(canonical(lines.map(comparable))!==canonical(payload.before.items.map(comparable)))throw Error('Receiving draft lines changed.');
  if(remaining.entry){
    if(remaining.entry.inward_no!==previous.inward_no||remaining.entry.posting_status!=='DRAFT'||Number(remaining.entry.total_qty)!==0
      ||remaining.items.some(row=>row.inward_no!==previous.inward_no)||remaining.items.length!==Number(remaining.entry.item_count)
      ||!matchesRoundedSum(remaining.items.reduce((sum,row)=>sum+quantity(row.total_amount),0n),quantity(remaining.entry.grand_total),remaining.items.length))throw Error('Remaining draft does not reconcile.');
  }else if(remaining.items.length)throw Error('Deleted draft cannot retain lines.');
  await applyPurchase(connection,{...payload,operation:'create'});
  if(remaining.entry){
    await updateRow(connection,'inward_entries',remaining.entry,targets[0].id);
    await connection.execute('DELETE FROM inward_items WHERE inward_no=?',[previous.inward_no]);
    for(const item of remaining.items)await insert(connection,'inward_items',item);
  }else await connection.execute('DELETE FROM inward_entries WHERE inward_no=?',[previous.inward_no]);
}
async function updateRow(connection,table,row,id){
  const [schema]=await connection.query('SHOW COLUMNS FROM `'+table+'`');const allowed=new Set(schema.map(column=>column.Field));
  const keys=Object.keys(row).filter(key=>key!=='id');
  if(keys.some(key=>!allowed.has(key)||!/^[a-z_][a-z0-9_]*$/.test(key)))throw Error('Replacement schema mismatch.');
  await connection.execute('UPDATE `'+table+'` SET '+keys.map(key=>'`'+key+'`=?').join(',')+' WHERE id=?',[...keys.map(key=>row[key]),id]);
}
async function applyPurchaseReplacement(connection,payload){
  const before=payload.before;let after=payload.after;
  if(!before?.entry||!payload.entry||before.entry.inward_no!==payload.inwardNo||payload.entry.inward_no!==payload.inwardNo
    ||!Array.isArray(before.items)||!Array.isArray(payload.items)||!payload.items.length||!Array.isArray(before.payments)
    ||[...before.items,...payload.items].some(row=>Number(row.free_offer_enabled)!==0))throw Error('Purchase replacement requires reconciliation.');
  const entries=await rows(connection,'SELECT * FROM inward_entries WHERE inward_no=? FOR UPDATE',[payload.inwardNo]);
  const headerComparable=row=>Object.fromEntries(Object.entries(comparable(row)).filter(([key])=>!['paid_amount','due_amount','payment_status'].includes(key)));
  if(entries.length!==1||canonical(headerComparable(entries[0]))!==canonical(headerComparable(before.entry)))throw Error('Receiving purchase changed before replacement.');
  const items=await rows(connection,'SELECT * FROM inward_items WHERE inward_no=? ORDER BY id FOR UPDATE',[payload.inwardNo]);
  if(canonical(items.map(comparable))!==canonical(before.items.map(comparable)))throw Error('Receiving purchase lines changed before replacement.');
  const payments=await rows(connection,'SELECT * FROM supplier_payments WHERE inward_no=? ORDER BY id FOR UPDATE',[payload.inwardNo]);
  const replacementEntry=(before.payments.length||payments.length)
    ?reconcilePurchasePayments({before:before.entry,after:payload.entry,sourcePayments:before.payments,target:entries[0],targetPayments:payments})
    :payload.entry;
  if(!before.payments.length&&!payments.length&&canonical(comparable(entries[0]))!==canonical(comparable(before.entry)))throw Error('Receiving purchase balance changed before replacement.');
  let total=0n;for(const item of payload.items){if(item.inward_no!==payload.inwardNo)throw Error('Invalid replacement line.');total+=quantity(item.total_amount);}
  if(!matchesRoundedSum(total,quantity(payload.entry.grand_total),payload.items.length)||Number(payload.entry.item_count)!==payload.items.length)throw Error('Replacement totals do not reconcile.');
  // Apply the source purchase delta without resetting receiving-side sales.
  const codes=[...new Set([...before.products,...after.products].map(row=>row.barcode))].sort();
  const current=await inventory(connection,codes,true);
  after=reconcilePurchaseInventory(before,after,current);
  if(new Set(before.batches.map(batchKey)).size!==before.batches.length||new Set(after.batches.map(batchKey)).size!==after.batches.length)throw Error('Ambiguous replacement batch identity.');
  if(before.products.some(row=>!after.products.some(next=>next.barcode===row.barcode)))throw Error('Replacement cannot delete a product master.');
  for(const product of after.products){
    if(quantity(product.stock_qty)<0n)throw Error('Replacement stock cannot be negative.');
    const target=current.products.find(row=>row.barcode===product.barcode);
    if(target)await updateRow(connection,'products',product,target.id);else await insert(connection,'products',product);
  }
  for(const batch of current.batches){
    if(!after.batches.some(next=>batchKey(next)===batchKey(batch))){
      if(quantity(batch.quantity_available)!==quantity(batch.quantity_received))throw Error('Cannot remove a consumed batch during replacement.');
      await connection.execute('DELETE FROM product_batches WHERE id=?',[batch.id]);
    }
  }
  for(const batch of after.batches){
    if(quantity(batch.quantity_available)<0n||quantity(batch.quantity_received)<quantity(batch.quantity_available))throw Error('Replacement batch quantities invalid.');
    const target=current.batches.find(row=>batchKey(row)===batchKey(batch));
    if(target)await updateRow(connection,'product_batches',batch,target.id);else await insert(connection,'product_batches',batch);
  }
  await updateRow(connection,'inward_entries',replacementEntry,entries[0].id);
  await connection.execute('DELETE FROM inward_items WHERE inward_no=?',[payload.inwardNo]);
  for(const item of payload.items)await insert(connection,'inward_items',item);
}
async function applyPurchaseDeletion(connection,payload){
  const before=payload.before;
  if(payload.entry!==null||payload.items?.length!==0||!before?.entry||before.entry.inward_no!==payload.inwardNo
    ||!Array.isArray(before.items)||!Array.isArray(before.payments)||before.payments.length
    ||before.items.some(row=>Number(row.free_offer_enabled)!==0))throw Error('Purchase deletion requires reconciliation.');
  const targets=await rows(connection,'SELECT * FROM inward_entries WHERE inward_no=? FOR UPDATE',[payload.inwardNo]);
  if(targets.length!==1||canonical(comparable(targets[0]))!==canonical(comparable(before.entry)))throw Error('Purchase changed before deletion; review required.');
  const items=await rows(connection,'SELECT * FROM inward_items WHERE inward_no=? ORDER BY id FOR UPDATE',[payload.inwardNo]);
  if(canonical(items.map(comparable))!==canonical(before.items.map(comparable)))throw Error('Purchase lines changed before deletion.');
  const payments=await rows(connection,'SELECT id FROM supplier_payments WHERE inward_no=? FOR UPDATE',[payload.inwardNo]);
  if(payments.length)throw Error('Purchase has receiving-side payments; review required.');
  const removed=before.batches.filter(row=>!payload.after.batches.some(next=>String(next.id)===String(row.id)));
  const deductions=new Map();
  for(const batch of removed){
    if(batch.inward_no!==payload.inwardNo||quantity(batch.quantity_available)!==quantity(batch.quantity_received))throw Error('Source purchase batch cannot be deleted.');
    deductions.set(batch.barcode,(deductions.get(batch.barcode)||0n)+quantity(batch.quantity_received));
  }
  if([...deductions.values()].reduce((sum,value)=>sum+value,0n)!==quantity(before.entry.total_qty))throw Error('Merged purchase batches require manual reconciliation before deletion.');
  const targetPurchaseBatches=await rows(connection,'SELECT barcode,batch_no,expiry_date FROM product_batches WHERE inward_no=? FOR UPDATE',[payload.inwardNo]);
  if(canonical(targetPurchaseBatches.map(batchKey).sort())!==canonical(removed.map(batchKey).sort()))throw Error('Receiving purchase batch set changed.');
  for(const product of before.products){
    const after=payload.after.products.find(row=>row.barcode===product.barcode);
    if(!after||quantity(product.stock_qty)-quantity(after.stock_qty)!==(deductions.get(product.barcode)||0n))throw Error('Purchase deletion stock does not reconcile.');
  }
  for(const barcode of [...deductions.keys()].sort()){
    const products=await rows(connection,'SELECT stock_qty FROM products WHERE barcode=? FOR UPDATE',[barcode]);
    if(products.length!==1||quantity(products[0].stock_qty)<deductions.get(barcode))throw Error('Insufficient receiving stock to delete purchase.');
  }
  for(const batch of removed){
    const matching=await rows(connection,'SELECT * FROM product_batches WHERE barcode=? AND batch_no=? AND expiry_date <=> ? FOR UPDATE',[batch.barcode,batch.batch_no,batch.expiry_date]);
    if(matching.length!==1||matching[0].inward_no!==batch.inward_no||quantity(matching[0].quantity_received)!==quantity(batch.quantity_received)
      ||quantity(matching[0].quantity_available)!==quantity(batch.quantity_available))throw Error('Purchase batch was sold or changed on receiver; deletion blocked.');
    await connection.execute('DELETE FROM product_batches WHERE id=?',[matching[0].id]);
  }
  for(const [barcode,amount] of deductions)await connection.execute('UPDATE products SET stock_qty=stock_qty-?,updated_at=CURRENT_TIMESTAMP WHERE barcode=?',[format(amount),barcode]);
  await connection.execute('DELETE FROM inward_entries WHERE inward_no=?',[payload.inwardNo]);
}
module.exports={beginPurchaseCapture,finishPurchaseCapture,applyPurchase};
