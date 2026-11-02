const fs=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto');
const {canonical,validateEvent}=require('./syncEventProtocol');
const {atomic,json}=require('./recoveryControlFiles');
const supported=new Set(['pos.checkout.recorded','pos.invoice.returned','pos.invoice.cancelled','pos.purchase.changed','pos.supplier-payment.recorded','pos.stock.adjusted']);
function createFinancialConflictCases({directory,identity}){
  if(!path.isAbsolute(directory))throw Error('Protected case directory required.');
  const root=path.join(directory,identity.shopId);
  const file=id=>{if(!/^[a-f0-9]{64}$/.test(id))throw Error('Invalid financial case.');return path.join(root,id+'.json');};
  async function read(id){const value=await json(file(id));if(value.shopId!==identity.shopId||value.id!==id||validateEvent(value.event,identity).hash!==id||!Array.isArray(value.history))throw Error('Financial case integrity failure.');return value;}
  function summary(value){const p=value.event.payload;return {id:value.id,type:value.event.type,eventId:value.event.eventId,origin:value.event.originInstallationId,reference:p.invoice?.invoice_no||p.inwardNo||p.payment?.inward_no||p.adjustment?.barcode||p.barcode||'',amount:p.invoice?.grand_total??p.entry?.grand_total??p.payment?.amount??null,status:value.status,revision:value.revision,createdAt:value.createdAt,history:value.history};}
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
  async function retry(id,{expectedRevision,actor,note},receive){
    if(!Number.isSafeInteger(expectedRevision)||typeof actor!=='string'||!actor.trim()||typeof note!=='string'||note.trim().length<5||note.length>2000)throw Error('Describe the correction and use the current case revision.');
    const lock=await fs.open(file(id)+'.lock','wx',0o600);
    try{
      const value=await read(id);if(value.revision!==expectedRevision)throw Error('Case changed; reload it.');
      const audit={actor,note:note.trim(),at:new Date().toISOString(),outcome:'attempting'};value.history.push(audit);value.revision++;await atomic(file(id),value);
      try{const result=await receive(value.event);if(result.committed!==true)throw Error('No commit');value.status='resolved';audit.outcome='committed';}
      catch{value.status='needs-correction';audit.outcome='still-blocked';}
      await atomic(file(id),value);return summary(value);
    }finally{await lock.close();await fs.unlink(file(id)+'.lock');}
  }
  async function inspect(id,pool){
    const value=await read(id),result=summary(value),p=value.event.payload;
    const pick=(row,keys)=>Object.fromEntries(keys.filter(key=>row&&Object.hasOwn(row,key)).map(key=>[key,row[key]]));
    if(p.inwardNo||p.payment?.inward_no){
      const reference=p.inwardNo||p.payment.inward_no,fields=['supplier_name','grand_total','paid_amount','due_amount','payment_status'];
      const [[current]]=await pool.execute('SELECT supplier_name,grand_total,paid_amount,due_amount,payment_status FROM inward_entries WHERE inward_no=?',[reference]);
      result.comparison={sourceBefore:pick(p.before?.entry||p.before,fields),sourceAfter:pick(p.entry||p.after,fields),current:pick(current,fields)};
    }else if(p.adjustment){
      const [[current]]=await pool.execute('SELECT stock_qty FROM products WHERE barcode=?',[p.adjustment.barcode]);
      result.comparison={sourceBefore:{stock_qty:p.adjustment.old_qty},sourceAfter:{stock_qty:p.adjustment.new_qty},current:pick(current,['stock_qty'])};
    }else if(p.invoice){
      const fields=['invoice_status','grand_total','payment_mode','customer_name'];
      const [[current]]=await pool.execute('SELECT invoice_status,grand_total,payment_mode,customer_name FROM invoices WHERE invoice_no=?',[p.invoice.invoice_no]);
      result.comparison={sourceAfter:pick(p.invoice,fields),current:pick(current,fields)};
    }
    return result;
  }
  return {record,list,read:async id=>summary(await read(id)),inspect,retry};
}
module.exports={createFinancialConflictCases};
