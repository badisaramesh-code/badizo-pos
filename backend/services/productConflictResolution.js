const {canonical,validateEvent}=require('./syncEventProtocol');
const {normalize,applyProductFields}=require('./productSyncHandler');
function fieldEvent(event){
  if(event.type==='pos.product.fields.changed'){
    const payload=event.payload;
    if(!payload||Object.keys(payload).sort().join(',')!=='barcode,changes'||typeof payload.barcode!=='string'||!payload.barcode||payload.barcode.length>120||!Array.isArray(payload.changes)||!payload.changes.length||payload.changes.length>2)throw Error('Invalid covered product event.');
    const seen=new Set();
    const changes=payload.changes.map(change=>{
      if(!change||Object.keys(change).sort().join(',')!=='after,before,field'||seen.has(change.field))throw Error('Invalid covered product field.');
      seen.add(change.field);return {field:change.field,before:normalize(change.field,change.before),after:normalize(change.field,change.after)};
    });
    return {barcode:payload.barcode,changes};
  }
  if(event.type!=='pos.product.changed')return null;
  const {before,after}=event.payload||{};
  if(!before||!after||before.barcode!==after.barcode)return null;
  const changes=[];
  for(const field of new Set([...Object.keys(before),...Object.keys(after)])){
    if(['id','created_at','updated_at','previous_updated_at'].includes(field))continue;
    if(canonical(before[field])===canonical(after[field]))continue;
    if(!['product_name','sale_price'].includes(field))return null;
    changes.push({field,before:normalize(field,before[field]),after:normalize(field,after[field])});
  }
  return {barcode:before.barcode,changes};
}
async function receipt(connection,event,identity){
  const checked=validateEvent(event,identity);
  const [existing]=await connection.execute('SELECT payload_hash FROM sync_inbox WHERE shop_id=? AND event_id=? FOR UPDATE',[event.shopId,event.eventId]);
  if(existing.length){if(existing[0].payload_hash!==checked.hash)throw Error('Resolved event identity was reused.');return;}
  await connection.execute('INSERT INTO sync_inbox (shop_id,event_id,origin_installation_id,payload_hash) VALUES (?,?,?,?)',[event.shopId,event.eventId,event.originInstallationId,checked.hash]);
}
async function applyProductResolution(connection,payload,context){
  if(!payload||Object.keys(payload).sort().join(',')!=='barcode,changes,supersededEvents'||!Array.isArray(payload.supersededEvents)||payload.supersededEvents.length>1000)throw Error('Invalid product resolution.');
  await applyProductFields(connection,{barcode:payload.barcode,changes:payload.changes});
  const fields=new Set(payload.changes.map(change=>change.field));
  for(const event of payload.supersededEvents){
    const original=fieldEvent(event);
    if(!original||original.barcode!==payload.barcode||!original.changes.length||original.changes.some(change=>!fields.has(change.field)))throw Error('Resolution cannot replace an unrelated event.');
    await receipt(connection,event,{shopId:context.shopId,peerInstallationId:context.originInstallationId,localInstallationId:context.localInstallationId});
  }
}
module.exports={fieldEvent,receipt,applyProductResolution};
