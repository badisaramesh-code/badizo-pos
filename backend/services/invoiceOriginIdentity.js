const {canonical,validateEvent}=require('./syncEventProtocol');
const plain=row=>Object.fromEntries(Object.entries(row).filter(([key])=>key!=='id'));
async function rows(connection,sql,args){const [result]=await connection.query({sql,dateStrings:true,supportBigNumbers:true,bigNumberStrings:true},args);return JSON.parse(JSON.stringify(result));}
async function invoiceSnapshot(connection,invoiceNo){
  const read=table=>rows(connection,`SELECT * FROM ${table} WHERE invoice_no=? ORDER BY id FOR UPDATE`,[invoiceNo]);
  const invoices=await read('invoices');
  if(invoices.length!==1)throw Error('Invoice baseline is missing.');
  return {invoice:invoices[0],items:await read('invoice_items'),payments:await read('invoice_payments'),batchAllocations:await read('invoice_item_batches'),loyaltyTransactions:await read('loyalty_transactions')};
}
function supportedBaseline(snapshot){
  return snapshot?.invoice?.invoice_status==='PAID'&&Number(snapshot.invoice.exchange_total)===0&&snapshot.invoice.exchange_items_json===null
    &&Number(snapshot.invoice.loyalty_redeemed_points)===0&&Number(snapshot.invoice.loyalty_redeemed_amount)===0
    &&Array.isArray(snapshot.loyaltyTransactions)&&snapshot.loyaltyTransactions.length===0&&Array.isArray(snapshot.items)&&snapshot.items.length>0
    &&snapshot.items.every(item=>Number(item.returned_qty)===0&&Number(item.is_free_bonus)===0&&item.free_offer_id===null);
}
async function captureHistoricalBaseline(connection,invoiceNo,env=process.env){
  if(env.BADIZO_SYNC_CHECKOUT_CAPTURE!=='true')return null;
  const [maps]=await connection.execute('SELECT target_invoice_no FROM sync_invoice_map WHERE shop_id=? AND target_invoice_no=? FOR UPDATE',[env.BADIZO_SHOP_ID,invoiceNo]);
  if(maps.length)return null;
  const snapshot=await invoiceSnapshot(connection,invoiceNo);
  // Only an untouched bill can establish this baseline. Earlier partial
  // returns require reconciliation of their complete history.
  if(!supportedBaseline(snapshot))return null;
  const [returns]=await connection.execute('SELECT return_no FROM sales_returns WHERE invoice_no=? FOR UPDATE',[invoiceNo]);
  if(returns.length)return null;
  await createSelfMapping(connection,snapshot,env.BADIZO_SHOP_ID,env.BADIZO_INSTALLATION_ID);
  return snapshot;
}
// A received invoice keeps its original identity even when its next return or
// cancellation is performed on the other server. Numeric IDs are translated
// through the recorded mapping, never guessed from barcode or line position.
async function normalizeLifecycle(connection,payload,identity){
  const maps=await rows(connection,'SELECT origin_installation_id,source_invoice_no,checkout_payload FROM sync_invoice_map WHERE shop_id=? AND target_invoice_no=? FOR UPDATE',[identity.shopId,payload.invoice.invoice_no]);
  if(!maps.length)return payload; // Locally originated or pre-enrollment bill.
  if(maps.length!==1)throw Error('Ambiguous invoice origin.');
  const map=maps[0];
  if(map.origin_installation_id===identity.localInstallationId)return payload;
  if(map.origin_installation_id!==identity.peerInstallationId)throw Error('Invoice belongs to an earlier installation; baseline reconciliation required.');
  const original=JSON.parse(map.checkout_payload);
  const itemMaps=await rows(connection,'SELECT source_item_id,target_item_id FROM sync_invoice_item_map WHERE shop_id=? AND origin_installation_id=? AND source_invoice_no=?',[identity.shopId,map.origin_installation_id,map.source_invoice_no]);
  if(itemMaps.length!==original.items.length||payload.items.length!==original.items.length)throw Error('Invoice line identity is incomplete.');
  const sourceForTarget=new Map();
  const items=original.items.map(item=>{
    const mapped=itemMaps.find(row=>String(row.source_item_id)===String(item.id));
    const current=mapped&&payload.items.find(row=>String(row.id)===String(mapped.target_item_id));
    if(!current)throw Error('Invoice line identity is missing.');
    sourceForTarget.set(String(current.id),item.id);
    return {...current,id:item.id,invoice_no:map.source_invoice_no};
  });
  if(canonical(payload.payments.map(plain))!==canonical(original.payments.map(plain)))throw Error('Invoice payment details changed; review required.');
  if(payload.loyaltyTransactions.length||original.loyaltyTransactions.length)throw Error('Cross-server loyalty lifecycle requires its own reconciliation profile.');
  const batchMaps=await rows(connection,'SELECT source_allocation_id,target_allocation_id FROM sync_invoice_batch_map WHERE shop_id=? AND origin_installation_id=? AND source_invoice_no=?',[identity.shopId,map.origin_installation_id,map.source_invoice_no]);
  if(batchMaps.length!==original.batchAllocations.length||payload.batchAllocations.length!==original.batchAllocations.length)throw Error('Invoice batch identity is incomplete.');
  const batchAllocations=original.batchAllocations.map(before=>{
    const mapped=batchMaps.find(row=>String(row.source_allocation_id)===String(before.id));
    const current=mapped&&payload.batchAllocations.find(row=>String(row.id)===String(mapped.target_allocation_id));
    if(!current||sourceForTarget.get(String(current.invoice_item_id))===undefined)throw Error('Invoice batch line identity missing.');
    return {...current,id:before.id,invoice_item_id:before.invoice_item_id,invoice_no:map.source_invoice_no};
  });
  return {...payload,checkoutOrigin:map.origin_installation_id,invoice:{...payload.invoice,id:original.invoice.id,invoice_no:map.source_invoice_no},items,payments:original.payments,batchAllocations,
    returns:payload.returns.map(row=>({...row,invoice_no:map.source_invoice_no})),returnItems:payload.returnItems.map(row=>{
      const source=sourceForTarget.get(String(row.invoice_item_id));if(source===undefined)throw Error('Returned line mapping missing.');return {...row,invoice_item_id:source};
    })};
}
async function createSelfMapping(connection,original,shopId,origin){
  const invoiceNo=original.invoice.invoice_no;
  const live=await rows(connection,'SELECT id FROM invoices WHERE invoice_no=? FOR UPDATE',[invoiceNo]);
  if(live.length!==1||String(live[0].id)!==String(original.invoice.id))throw Error('Original invoice identity changed after restore.');
  const lines=await rows(connection,'SELECT id,barcode FROM invoice_items WHERE invoice_no=? ORDER BY id FOR UPDATE',[invoiceNo]);
  if(lines.length!==original.items.length||original.items.some(item=>!lines.some(row=>String(row.id)===String(item.id)&&row.barcode===item.barcode)))throw Error('Original invoice lines changed after restore.');
  await connection.execute('INSERT INTO sync_invoice_map (shop_id,origin_installation_id,source_invoice_no,target_invoice_no,checkout_payload) VALUES (?,?,?,?,?)',[shopId,origin,invoiceNo,invoiceNo,JSON.stringify(original)]);
  for(const item of original.items)await connection.execute('INSERT INTO sync_invoice_item_map (shop_id,origin_installation_id,source_invoice_no,source_item_id,target_item_id) VALUES (?,?,?,?,?)',[shopId,origin,invoiceNo,String(item.id),String(item.id)]);
  for(const allocation of original.batchAllocations){
    const matches=await rows(connection,'SELECT id FROM product_batches WHERE barcode=? AND batch_no=? AND expiry_date <=> ? FOR UPDATE',[allocation.barcode,allocation.batch_no,allocation.expiry_date]);
    if(matches.length!==1)throw Error('Original batch identity missing or ambiguous.');
    await connection.execute('INSERT INTO sync_invoice_batch_map (shop_id,origin_installation_id,source_invoice_no,source_allocation_id,target_allocation_id,target_batch_id) VALUES (?,?,?,?,?,?)',[shopId,origin,invoiceNo,String(allocation.id),String(allocation.id),matches[0].id]);
  }
}
async function lifecycleContext(connection,payload,context){
  if(payload.checkoutOrigin===undefined&&payload.checkoutBaseline===undefined)return context;
  const origin=payload.checkoutOrigin??context.originInstallationId;
  if(!context||![context.originInstallationId,context.localInstallationId].includes(origin))throw Error('Unknown checkout origin.');
  const [maps]=await connection.execute('SELECT target_invoice_no FROM sync_invoice_map WHERE shop_id=? AND origin_installation_id=? AND source_invoice_no=? FOR UPDATE',[context.shopId,origin,payload.invoice.invoice_no]);
  if(!maps.length&&payload.checkoutBaseline!==undefined&&origin===context.originInstallationId){
    const baseline=payload.checkoutBaseline;
    if(baseline?.invoice?.invoice_no!==payload.invoice.invoice_no||!supportedBaseline(baseline))throw Error('Unsupported historical invoice baseline.');
    const live=await invoiceSnapshot(connection,payload.invoice.invoice_no);
    // Exact complete snapshots, including IDs, must agree. This never matches
    // unrelated bills by totals/barcode or changes stock to force a match.
    if(canonical(live)!==canonical(baseline))throw Error('Historical invoice differs from the backup baseline; reconciliation required.');
    const [returns]=await connection.execute('SELECT return_no FROM sales_returns WHERE invoice_no=? FOR UPDATE',[payload.invoice.invoice_no]);
    if(returns.length)throw Error('Historical invoice has independent returns.');
    await createSelfMapping(connection,baseline,context.shopId,origin);
  }
  if(!maps.length&&origin===context.localInstallationId){
    const [events]=await connection.execute("SELECT event_json,payload_hash FROM sync_outbox WHERE shop_id=? AND origin_installation_id=? AND JSON_UNQUOTE(JSON_EXTRACT(event_json,'$.type'))='pos.checkout.recorded' AND JSON_UNQUOTE(JSON_EXTRACT(event_json,'$.payload.invoice.invoice_no'))=? ORDER BY sequence_no LIMIT 2",[context.shopId,origin,payload.invoice.invoice_no]);
    if(events.length!==1)throw Error('Original checkout evidence is missing or ambiguous.');
    const event=typeof events[0].event_json==='string'?JSON.parse(events[0].event_json):events[0].event_json;
    const verified=validateEvent(event,{shopId:context.shopId,peerInstallationId:origin,localInstallationId:context.originInstallationId});
    if(verified.hash!==events[0].payload_hash)throw Error('Original checkout evidence was altered.');
    await createSelfMapping(connection,event.payload,context.shopId,origin);
  }
  return {...context,originInstallationId:origin};
}
module.exports={normalizeLifecycle,lifecycleContext,createSelfMapping,captureHistoricalBaseline,invoiceSnapshot};
