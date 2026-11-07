const fs=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto');
const {canonical,validateEvent}=require('./syncEventProtocol');
const {atomic,json}=require('./recoveryControlFiles');
const supported=new Set(['pos.checkout.recorded','pos.invoice.returned','pos.invoice.cancelled','pos.purchase.changed','pos.supplier-payment.recorded','pos.stock.adjusted','pos.recovery.supplier-payment-matched','pos.recovery.stock-deltas-reviewed']);
function createFinancialConflictCases({directory,identity,pool=null}){
  if(!path.isAbsolute(directory))throw Error('Protected case directory required.');
  const root=path.join(directory,identity.shopId);
  const file=id=>{if(!/^[a-f0-9]{64}$/.test(id))throw Error('Invalid financial case.');return path.join(root,id+'.json');};
  async function read(id){const value=await json(file(id));if(value.shopId!==identity.shopId||value.id!==id||validateEvent(value.event,identity).hash!==id||!Array.isArray(value.history))throw Error('Financial case integrity failure.');return value;}
  function detailPayload(event){return event.type.startsWith('pos.recovery.')?event.payload.incomingEvent?.payload||event.payload:event.payload;}
  function summary(value){const p=detailPayload(value.event);return {id:value.id,type:value.event.type,eventId:value.event.eventId,origin:value.event.originInstallationId,reference:p.invoice?.invoice_no||p.inwardNo||p.payment?.inward_no||p.adjustment?.barcode||p.barcode||'',amount:p.invoice?.grand_total??p.entry?.grand_total??p.payment?.amount??null,status:value.status,revision:value.revision,createdAt:value.createdAt,history:value.history};}
  async function record(event){
    if(!supported.has(event.type))return;
    const checked=validateEvent(event,identity);await fs.mkdir(root,{recursive:true,mode:0o700});
    try{return await read(checked.hash);}catch(error){if(error.code!=='ENOENT')throw error;}
    const value={schemaVersion:1,id:checked.hash,shopId:identity.shopId,event:JSON.parse(checked.serialized),status:'needs-correction',revision:0,createdAt:new Date().toISOString(),history:[]};
    // Exclusive publish preserves the first evidence when retries race.
    const temporary=path.join(root,crypto.randomUUID()+'.pending');await atomic(temporary,value);
    try{await fs.link(temporary,file(checked.hash));}catch(error){if(error.code!=='EEXIST')throw error;}finally{await fs.unlink(temporary);}
    return read(checked.hash);
  }
  async function list(){let files;try{files=await fs.readdir(root);}catch(error){if(error.code==='ENOENT')return [];throw error;}const result=[];for(const name of files.filter(n=>/^[a-f0-9]{64}\.json$/.test(n)).sort().slice(0,1000))result.push(summary(await read(name.slice(0,-5))));return result;}
  async function exclusive(id,operation){
    file(id);
    if(pool){
      const connection=await pool.getConnection(),name='badizo-case-'+crypto.createHash('sha256').update(identity.shopId+':'+id).digest('hex').slice(0,48);let locked=false,discarded=false;
      try{const [[row]]=await connection.execute('SELECT GET_LOCK(?,0) AS acquired',[name]);if(Number(row.acquired)!==1)throw Error('Case is already being corrected.');locked=true;return await operation();}
      finally{if(locked){try{await connection.execute('SELECT RELEASE_LOCK(?)',[name]);}catch{connection.destroy();discarded=true;}}if(!discarded)connection.release();}
    }
    // Filesystem-only stores are used by offline review tools/tests. Enrolled
    // execution always supplies a pool: its lock is released by MySQL after
    // process loss, so an interrupted correction can safely be retried.
    const lock=await fs.open(file(id)+'.lock','wx',0o600);
    try{return await operation();}finally{await lock.close();await fs.unlink(file(id)+'.lock');}
  }
  async function retry(id,{expectedRevision,actor,note,action='retry-original',targetPaymentId,expectedStock,expectedLocalAuditIds},receive){
    if(!Number.isSafeInteger(expectedRevision)||typeof actor!=='string'||!actor.trim()||typeof note!=='string'||note.trim().length<5||note.length>2000)throw Error('Describe the correction and use the current case revision.');
    if(!['retry-original','match-supplier-payment','accept-stock-delta'].includes(action))throw Error('Unknown correction action.');
    return exclusive(id,async()=>{
      const value=await read(id);if(value.revision!==expectedRevision)throw Error('Case changed; reload it.');
      const audit={actor,note:note.trim(),action,at:new Date().toISOString(),outcome:'attempting'};
      if(action==='match-supplier-payment'&&/^[1-9][0-9]{0,18}$/.test(String(targetPaymentId)))audit.selection={targetPaymentId:String(targetPaymentId)};
      if(action==='accept-stock-delta'&&/^-?\d{1,10}(\.\d{1,2})?$/.test(String(expectedStock))&&Array.isArray(expectedLocalAuditIds)&&expectedLocalAuditIds.length<=50&&expectedLocalAuditIds.every(id=>/^[a-f0-9-]{36}$/i.test(id)))audit.selection={expectedStock:String(expectedStock),expectedLocalAuditIds};
      value.history.push(audit);value.revision++;await atomic(file(id),value);
      try{const result=await receive(value.event);if(result.committed!==true)throw Error('No commit');value.status='resolved';audit.outcome='committed';if(result.requiresPeerDelivery)audit.peerDeliveryRequired=true;}
      catch{value.status='needs-correction';audit.outcome='still-blocked';}
      await atomic(file(id),value);return summary(value);
    });
  }
  async function inspect(id,pool){
    const value=await read(id),result=summary(value),p=detailPayload(value.event);
    const pick=(row,keys)=>Object.fromEntries(keys.filter(key=>row&&Object.hasOwn(row,key)).map(key=>[key,row[key]]));
    if(p.inwardNo||p.payment?.inward_no){
      const reference=p.inwardNo||p.payment.inward_no,fields=['supplier_name','grand_total','paid_amount','due_amount','payment_status'];
      const [[current]]=await pool.execute('SELECT supplier_name,grand_total,paid_amount,due_amount,payment_status FROM inward_entries WHERE inward_no=?',[reference]);
      result.comparison={sourceBefore:pick(p.before?.entry||p.before,fields),sourceAfter:pick(p.entry||p.after,fields),current:pick(current,fields)};
      if(value.event.type==='pos.supplier-payment.recorded'){
        const paymentFields=['id','inward_no','supplier_name','supplier_gstin','payment_date','amount','payment_mode','reference_no'];
        const [payments]=await pool.query({sql:'SELECT * FROM supplier_payments WHERE inward_no=? ORDER BY id DESC LIMIT 100',dateStrings:true,supportBigNumbers:true,bigNumberStrings:true},[reference]);
        const {paymentSignature}=require('./financialCorrectionExecution');
        let candidates=[];try{const source=canonical(paymentSignature(p.payment));candidates=payments.filter(payment=>{try{return canonical(paymentSignature(payment))===source;}catch{return false;}}).map(payment=>pick(payment,paymentFields));}catch{}
        result.paymentMatch={incoming:pick(p.payment,paymentFields),candidates};
      }
    }else if(p.adjustment){
      const [[current]]=await pool.execute('SELECT stock_qty FROM products WHERE barcode=?',[p.adjustment.barcode]);
      result.comparison={sourceBefore:{stock_qty:p.adjustment.old_qty},sourceAfter:{stock_qty:p.adjustment.new_qty},current:pick(current,['stock_qty'])};
      if(value.event.type==='pos.stock.adjusted'&&p.adjustment.reason==='STOCK_AUDIT'&&current){
        const {quantity,format}=require('./stockAdjustmentSync');
        const [batches]=await pool.execute('SELECT id FROM product_batches WHERE barcode=? LIMIT 1',[p.adjustment.barcode]);
        const [pending]=await pool.execute("SELECT event_json,payload_hash FROM sync_outbox WHERE shop_id=? AND origin_installation_id=? AND acknowledged_at IS NULL AND JSON_UNQUOTE(JSON_EXTRACT(event_json,'$.type'))='pos.stock.adjusted' AND JSON_UNQUOTE(JSON_EXTRACT(event_json,'$.payload.adjustment.reason'))='STOCK_AUDIT' AND JSON_UNQUOTE(JSON_EXTRACT(event_json,'$.payload.adjustment.barcode'))=? ORDER BY sequence_no LIMIT 51",[identity.shopId,identity.localInstallationId,p.adjustment.barcode]);
        try{
          const localAudits=pending.map(row=>{const event=typeof row.event_json==='string'?JSON.parse(row.event_json):row.event_json;if(validateEvent(event,{shopId:identity.shopId,peerInstallationId:identity.localInstallationId,localInstallationId:identity.peerInstallationId}).hash!==row.payload_hash)throw Error('Local stock evidence changed.');return {eventId:event.eventId,...pick(event.payload.adjustment,['old_qty','adjustment_qty','new_qty','note','created_by','created_at'])};});
          result.stockCorrection={expectedStock:format(quantity(current.stock_qty)),difference:format(quantity(p.adjustment.adjustment_qty)),resultingStock:format(quantity(current.stock_qty)+quantity(p.adjustment.adjustment_qty)),expectedPeerStock:format(quantity(p.adjustment.new_qty)),hasBatches:batches.length>0,localAudits};
        }catch{}
      }
    }else if(p.invoice){
      const fields=['invoice_status','grand_total','payment_mode','customer_name'];
      const [[current]]=await pool.execute('SELECT invoice_status,grand_total,payment_mode,customer_name FROM invoices WHERE invoice_no=?',[p.invoice.invoice_no]);
      result.comparison={sourceAfter:pick(p.invoice,fields),current:pick(current,fields)};
    }
    if(value.history.some(entry=>entry.peerDeliveryRequired)){
      const planId=crypto.createHash('sha256').update(canonical({financialCase:value.id})).digest('hex');
      const [applications]=await pool.execute('SELECT review_json FROM sync_recovery_applications WHERE shop_id=? AND plan_id=?',[identity.shopId,planId]);
      if(applications.length===1){
        const evidence=typeof applications[0].review_json==='string'?JSON.parse(applications[0].review_json):applications[0].review_json;
        if(evidence.resolutionEventId){
          const [outgoing]=await pool.execute('SELECT acknowledged_at FROM sync_outbox WHERE shop_id=? AND origin_installation_id=? AND event_id=?',[identity.shopId,identity.localInstallationId,evidence.resolutionEventId]);
          result.peerResolution={eventId:evidence.resolutionEventId,status:outgoing.length===1?(outgoing[0].acknowledged_at?'delivered':'pending'):'evidence-unavailable'};
        }
      }
    }
    return result;
  }
  return {record,list,read:async id=>summary(await read(id)),inspect,retry};
}
module.exports={createFinancialConflictCases};
