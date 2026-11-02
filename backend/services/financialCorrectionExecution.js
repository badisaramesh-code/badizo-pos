const crypto=require('node:crypto');
const {canonical,validateEvent,retainReceivedEvent}=require('./syncEventProtocol');
const {decimal}=require('./checkoutSyncHandler');
const {quantity,format}=require('./stockAdjustmentSync');
const {enqueue}=require('./syncOutbox');
const digest=value=>crypto.createHash('sha256').update(canonical(value)).digest('hex');
const plain=value=>JSON.parse(JSON.stringify(value));
async function rows(connection,sql,args){const [result]=await connection.query({sql,dateStrings:true,supportBigNumbers:true,bigNumberStrings:true},args);return plain(result);}
function balances(value){return Object.fromEntries(['grand_total','paid_amount','due_amount'].map(key=>[key,decimal(value?.[key]).toString()]));}
function paymentSignature(payment){
  if(!payment||!/^\d{4}-\d{2}-\d{2}$/.test(payment.payment_date||'')||!['Cash','UPI','Bank Transfer','Cheque','Other'].includes(payment.payment_mode))throw Error('Unsupported supplier payment.');
  const keys=['inward_no','supplier_name','supplier_gstin','payment_date','payment_mode','reference_no'];
  if(keys.some(key=>typeof payment[key]!=='string'))throw Error('Incomplete supplier payment.');
  return {...Object.fromEntries(keys.map(key=>[key,payment[key]])),amount:decimal(payment.amount).toString()};
}
function validatePayment(event){
  if(event.type!=='pos.supplier-payment.recorded'||Object.keys(event.payload||{}).sort().join(',')!=='after,before,payment')throw Error('Expected original supplier payment.');
  const {payment,before,after}=event.payload,amount=decimal(payment?.amount),b=balances(before),a=balances(after);
  paymentSignature(payment);
  if(!/^[1-9][0-9]{0,18}$/.test(String(payment.id))||amount<=0n||a.grand_total!==b.grand_total||BigInt(a.paid_amount)!==BigInt(b.paid_amount)+amount||BigInt(b.due_amount)!==BigInt(b.grand_total)-BigInt(b.paid_amount)||BigInt(a.due_amount)!==BigInt(a.grand_total)-BigInt(a.paid_amount)||BigInt(a.due_amount)<0n)throw Error('Supplier payment totals do not reconcile.');
  return {payment,before:b,after:a,amount};
}
function validatePair(incoming,local){
  const a=validatePayment(incoming),b=validatePayment(local);
  if(canonical(paymentSignature(a.payment))!==canonical(paymentSignature(b.payment))||canonical(a.before)!==canonical(b.before)||canonical(a.after)!==canonical(b.after))throw Error('Payments do not represent the same reviewed payment.');
  // This narrowly resolves a blocked double entry, not a general payment
  // deletion/refund tool. Both receipts must still describe the same balance.
  if(a.amount*2n<=BigInt(a.before.due_amount))throw Error('This payment requires ordinary financial reconciliation.');
  return a;
}
function audit(options){
  if(typeof options.actor!=='string'||!options.actor.trim()||options.actor.length>100||typeof options.note!=='string'||options.note.trim().length<10||options.note.length>2000||!Number.isSafeInteger(options.expectedRevision)||options.expectedRevision<0)throw Error('Signed-in owner, current revision and detailed verification note required.');
  return {actor:options.actor,note:options.note.trim(),at:new Date().toISOString()};
}
async function absentReceipt(connection,event){
  const [existing]=await connection.execute('SELECT payload_hash FROM sync_inbox WHERE shop_id=? AND event_id=? FOR UPDATE',[event.shopId,event.eventId]);
  if(existing.length)throw Error('Payment or stock event was already applied; refresh before correcting.');
}
async function addReceipt(connection,event,identity){
  const checked=validateEvent(event,identity);
  await connection.execute('INSERT INTO sync_inbox (shop_id,event_id,origin_installation_id,payload_hash) VALUES (?,?,?,?)',[event.shopId,event.eventId,event.originInstallationId,checked.hash]);
  await retainReceivedEvent(connection,event,identity);
}
async function currentPayment(connection,event){
  const {payment,after}=validatePayment(event);
  const live=await rows(connection,'SELECT * FROM supplier_payments WHERE id=? FOR UPDATE',[String(payment.id)]);
  if(live.length!==1||canonical(live[0])!==canonical(payment))throw Error('Recorded payment changed after capture.');
  const [entries]=await connection.execute('SELECT supplier_name,supplier_gstin,posting_status,grand_total,paid_amount,due_amount FROM inward_entries WHERE inward_no=? FOR UPDATE',[payment.inward_no]);
  if(entries.length!==1||entries[0].posting_status!=='POSTED'||entries[0].supplier_name!==payment.supplier_name||String(entries[0].supplier_gstin||'')!==payment.supplier_gstin||canonical(balances(entries[0]))!==canonical(after))throw Error('Purchase balance changed after review.');
}
async function addPaymentMap(connection,event,targetId){
  await connection.execute('INSERT INTO sync_supplier_payment_map (shop_id,origin_installation_id,source_payment_id,target_payment_id,payload_hash) VALUES (?,?,?,?,?)',[event.shopId,event.originInstallationId,String(event.payload.payment.id),String(targetId),digest(event.payload)]);
}
function parseStored(row,identity){
  const event=typeof row.event_json==='string'?JSON.parse(row.event_json):row.event_json;
  if(validateEvent(event,identity).hash!==row.payload_hash)throw Error('Original payment evidence was altered.');
  return event;
}
function stockAudit(event){
  const row=event.payload?.adjustment;
  if(event.type!=='pos.stock.adjusted'||Object.keys(event.payload||{}).join(',')!=='adjustment'||!row||Object.keys(row).sort().join(',')!=='adjustment_qty,barcode,created_at,created_by,id,new_qty,note,old_qty,product_name,reason'||row.reason!=='STOCK_AUDIT'||!/^[1-9][0-9]{0,18}$/.test(String(row.id))||typeof row.barcode!=='string'||!row.barcode||row.barcode.length>120||typeof row.product_name!=='string'||row.product_name.length>255||typeof row.created_by!=='string'||row.created_by.length>100||typeof row.note!=='string'||row.note.length>255||!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d{1,6})?$/.test(row.created_at||''))throw Error('Only a reviewed ordinary stock audit can be accepted as a difference.');
  const before=quantity(row.old_qty),delta=quantity(row.adjustment_qty),after=quantity(row.new_qty);
  if(!delta||before+delta!==after||after<0n)throw Error('Source stock adjustment does not reconcile.');
  return {row,before,delta,after};
}
async function applyReviewedDelta(connection,event,owner,expected){
  const {row,delta}=stockAudit(event);
  const [products]=await connection.execute('SELECT stock_qty,product_name FROM products WHERE barcode=? FOR UPDATE',[row.barcode]);
  if(products.length!==1||quantity(products[0].stock_qty)!==expected)throw Error('Stock changed after inspection; refresh and verify again.');
  const [batches]=await connection.execute('SELECT id FROM product_batches WHERE barcode=? LIMIT 1 FOR UPDATE',[row.barcode]);
  if(batches.length)throw Error('Batch stock requires a batch-specific correction.');
  const next=expected+delta;if(next<0n||next>999999999999n)throw Error('Resulting stock is out of range.');
  await connection.execute('INSERT INTO sync_stock_adjustment_map (shop_id,origin_installation_id,source_adjustment_id,source_json) VALUES (?,?,?,?)',[event.shopId,event.originInstallationId,String(row.id),JSON.stringify(row)]);
  const [result]=await connection.execute('INSERT INTO stock_adjustments (barcode,product_name,old_qty,adjustment_qty,new_qty,reason,note,created_by) VALUES (?,?,?,?,?,?,?,?)',[row.barcode,products[0].product_name,format(expected),format(delta),format(next),'OTHER',('Reviewed source audit '+event.eventId+': '+owner.note).slice(0,255),owner.actor]);
  await connection.execute('UPDATE sync_stock_adjustment_map SET target_adjustment_id=? WHERE shop_id=? AND origin_installation_id=? AND source_adjustment_id=?',[result.insertId,event.shopId,event.originInstallationId,String(row.id)]);
  await connection.execute('UPDATE products SET stock_qty=?,updated_at=CURRENT_TIMESTAMP WHERE barcode=?',[format(next),row.barcode]);
  return {receivingBefore:format(expected),receivingAfter:format(next),targetAdjustmentId:String(result.insertId)};
}
function verifyAuditChain(incomingEvent,localEvents,expected){
  const source=stockAudit(incomingEvent);let previous=source.before;
  if(!Array.isArray(localEvents)||localEvents.length>50||new Set(localEvents.map(event=>event.eventId)).size!==localEvents.length)throw Error('Invalid reviewed local stock audits.');
  for(const event of localEvents){const audit=stockAudit(event);if(audit.row.barcode!==source.row.barcode||audit.before!==previous)throw Error('Stock audits do not share an unchanged common baseline.');previous=audit.after;}
  if(localEvents.length&&previous!==expected)throw Error('Independent local stock changes need a fresh reconciliation.');
}
async function recordApplication(connection,{shopId,planId,decision,actor,revision,evidence}){
  await connection.execute('INSERT INTO sync_recovery_applications (shop_id,plan_id,revision,head_hash,actor,review_json) VALUES (?,?,?,?,?,?)',[shopId,planId,revision,digest(decision),actor,JSON.stringify(evidence)]);
}
function createFinancialCorrectionExecution({pool,identity,nodeRole,canApply=async()=>false,withWriteLease=async operation=>operation()}){
  async function execute(event,options,decision,operation){
    const checked=validateEvent(event,identity),owner=audit(options),planId=digest({financialCase:checked.hash});
    if(nodeRole!=='local-server'||await canApply()!==true)throw Error('Financial corrections must start on the enrolled local server.');
    return withWriteLease(async()=>{
      const connection=await pool.getConnection();let begun=false;
      try{
        await connection.beginTransaction();begun=true;
        const [existing]=await connection.execute('SELECT head_hash FROM sync_recovery_applications WHERE shop_id=? AND plan_id=? FOR UPDATE',[identity.shopId,planId]);
        if(existing.length){if(existing[0].head_hash!==digest(decision))throw Error('This case already has a different correction.');await connection.commit();begun=false;return {committed:true,duplicate:true,requiresPeerDelivery:decision.kind==='same-physical-supplier-payment'||!!decision.expectedLocalAuditIds?.length};}
        if(await canApply()!==true)throw Error('Recovery state changed.');
        await absentReceipt(connection,event);
        const evidence=await operation(connection,owner);
        await addReceipt(connection,event,identity);
        await recordApplication(connection,{shopId:identity.shopId,planId,decision,actor:owner.actor,revision:options.expectedRevision,evidence:{kind:decision.kind,originalEvent:event,decision,owner,...evidence}});
        await connection.commit();begun=false;return {committed:true,duplicate:false,requiresPeerDelivery:!!evidence.resolutionEventId};
      }catch(error){if(begun)await connection.rollback().catch(()=>{});throw error;}finally{connection.release();}
    });
  }
  async function matchPayment(event,options){
    if(!/^[1-9][0-9]{0,18}$/.test(String(options.targetPaymentId)))throw Error('Choose the existing local payment.');
    validatePayment(event);
    const decision={kind:'same-physical-supplier-payment',targetPaymentId:String(options.targetPaymentId)};
    return execute(event,options,decision,async(connection,owner)=>{
      const [pending]=await connection.execute("SELECT event_json,payload_hash FROM sync_outbox WHERE shop_id=? AND origin_installation_id=? AND acknowledged_at IS NULL AND JSON_UNQUOTE(JSON_EXTRACT(event_json,'$.type'))='pos.supplier-payment.recorded' AND JSON_UNQUOTE(JSON_EXTRACT(event_json,'$.payload.payment.id'))=? ORDER BY sequence_no LIMIT 2 FOR UPDATE",[identity.shopId,identity.localInstallationId,decision.targetPaymentId]);
      if(pending.length!==1)throw Error('Exactly one unacknowledged original local payment is required.');
      const localEvent=parseStored(pending[0],{shopId:identity.shopId,peerInstallationId:identity.localInstallationId,localInstallationId:identity.peerInstallationId});
      validatePair(event,localEvent);await currentPayment(connection,localEvent);
      await addPaymentMap(connection,event,decision.targetPaymentId);
      const resolution={eventId:crypto.randomUUID(),shopId:identity.shopId,originInstallationId:identity.localInstallationId,type:'pos.recovery.supplier-payment-matched',schemaVersion:1,payload:{incomingEvent:event,localEvent,owner}};
      await enqueue(connection,resolution,identity);
      return {localEvent,resolutionEventId:resolution.eventId};
    });
  }
  async function acceptStockDelta(event,options){
    const {row,delta,after}=stockAudit(event),expected=quantity(options.expectedStock);
    if(!Array.isArray(options.expectedLocalAuditIds)||options.expectedLocalAuditIds.length>50||options.expectedLocalAuditIds.some(id=>typeof id!=='string'))throw Error('Review the listed pending local stock audits.');
    const decision={kind:'accept-stock-audit-delta',expectedStock:format(expected),delta:format(delta),expectedLocalAuditIds:options.expectedLocalAuditIds,expectedPeerStock:format(after)};
    return execute(event,options,decision,async(connection,owner)=>{
      const [pending]=await connection.execute("SELECT event_json,payload_hash FROM sync_outbox WHERE shop_id=? AND origin_installation_id=? AND acknowledged_at IS NULL AND JSON_UNQUOTE(JSON_EXTRACT(event_json,'$.type'))='pos.stock.adjusted' AND JSON_UNQUOTE(JSON_EXTRACT(event_json,'$.payload.adjustment.reason'))='STOCK_AUDIT' AND JSON_UNQUOTE(JSON_EXTRACT(event_json,'$.payload.adjustment.barcode'))=? ORDER BY sequence_no LIMIT 51 FOR UPDATE",[identity.shopId,identity.localInstallationId,row.barcode]);
      const localEvents=pending.map(row=>parseStored(row,{shopId:identity.shopId,peerInstallationId:identity.localInstallationId,localInstallationId:identity.peerInstallationId}));
      if(canonical(localEvents.map(event=>event.eventId))!==canonical(options.expectedLocalAuditIds))throw Error('Pending local stock audits changed since inspection.');
      verifyAuditChain(event,localEvents,expected);
      const evidence=await applyReviewedDelta(connection,event,owner,expected);
      if(localEvents.length){
        const resolution={eventId:crypto.randomUUID(),shopId:identity.shopId,originInstallationId:identity.localInstallationId,type:'pos.recovery.stock-deltas-reviewed',schemaVersion:1,payload:{incomingEvent:event,localEvents,owner,decision}};
        await enqueue(connection,resolution,identity);evidence.resolutionEventId=resolution.eventId;
      }
      return {...evidence,localEvents};
    });
  }
  return {matchPayment,acceptStockDelta,enabled:nodeRole==='local-server'};
}
async function applyReviewedStockDeltas(connection,payload,context){
  if(!payload||Object.keys(payload).sort().join(',')!=='decision,incomingEvent,localEvents,owner')throw Error('Invalid stock correction resolution.');
  const {incomingEvent,localEvents,owner,decision}=payload;
  const ownIdentity={shopId:context.shopId,peerInstallationId:context.localInstallationId,localInstallationId:context.originInstallationId},peerIdentity={shopId:context.shopId,peerInstallationId:context.originInstallationId,localInstallationId:context.localInstallationId};
  const own=validateEvent(incomingEvent,ownIdentity),source=stockAudit(incomingEvent);
  if(!decision||Object.keys(decision).sort().join(',')!=='delta,expectedLocalAuditIds,expectedPeerStock,expectedStock,kind'||decision.kind!=='accept-stock-audit-delta'||quantity(decision.expectedPeerStock)!==source.after||quantity(decision.delta)!==source.delta)throw Error('Stock correction does not match source evidence.');
  verifyAuditChain(incomingEvent,localEvents,quantity(decision.expectedStock));
  if(!localEvents.length||canonical(localEvents.map(event=>event.eventId))!==canonical(decision.expectedLocalAuditIds))throw Error('Reviewed local audit list differs.');
  audit({...owner,expectedRevision:0});
  const [proof]=await connection.execute('SELECT event_json,payload_hash FROM sync_outbox WHERE shop_id=? AND origin_installation_id=? AND event_id=? FOR UPDATE',[context.shopId,context.localInstallationId,incomingEvent.eventId]);
  if(proof.length!==1||canonical(parseStored(proof[0],ownIdentity))!==canonical(incomingEvent))throw Error('Original stock audit evidence is unavailable.');
  let expected=quantity(decision.expectedPeerStock);const applied=[];
  for(const event of localEvents){validateEvent(event,peerIdentity);await absentReceipt(connection,event);const result=await applyReviewedDelta(connection,event,owner,expected);expected=quantity(result.receivingAfter);applied.push(result);await addReceipt(connection,event,peerIdentity);}
  await recordApplication(connection,{shopId:context.shopId,planId:digest({financialCase:own.hash}),decision,actor:owner.actor,revision:0,evidence:{kind:decision.kind,originalEvent:incomingEvent,localEvents,owner,decision,applied,resolutionEventId:context.eventId}});
}
async function applyMatchedSupplierPayment(connection,payload,context){
  if(!payload||Object.keys(payload).sort().join(',')!=='incomingEvent,localEvent,owner')throw Error('Invalid payment match resolution.');
  const {incomingEvent,localEvent,owner}=payload;
  const ownIdentity={shopId:context.shopId,peerInstallationId:context.localInstallationId,localInstallationId:context.originInstallationId};
  const peerIdentity={shopId:context.shopId,peerInstallationId:context.originInstallationId,localInstallationId:context.localInstallationId};
  const own=validateEvent(incomingEvent,ownIdentity);validateEvent(localEvent,peerIdentity);validatePair(incomingEvent,localEvent);
  audit({...owner,expectedRevision:0});
  const [proof]=await connection.execute('SELECT event_json,payload_hash FROM sync_outbox WHERE shop_id=? AND origin_installation_id=? AND event_id=? FOR UPDATE',[context.shopId,context.localInstallationId,incomingEvent.eventId]);
  if(proof.length!==1||canonical(parseStored(proof[0],ownIdentity))!==canonical(incomingEvent))throw Error('Original receiving payment evidence is unavailable.');
  await absentReceipt(connection,localEvent);await currentPayment(connection,incomingEvent);
  await addPaymentMap(connection,localEvent,incomingEvent.payload.payment.id);
  await addReceipt(connection,localEvent,peerIdentity);
  const decision={kind:'same-physical-supplier-payment',targetPaymentId:String(localEvent.payload.payment.id)};
  await recordApplication(connection,{shopId:context.shopId,planId:digest({financialCase:own.hash}),decision,actor:owner.actor,revision:0,evidence:{kind:decision.kind,originalEvent:incomingEvent,localEvent,owner,resolutionEventId:context.eventId}});
}
module.exports={createFinancialCorrectionExecution,applyMatchedSupplierPayment,applyReviewedStockDeltas,paymentSignature,validatePayment,validatePair,stockAudit,verifyAuditChain};
