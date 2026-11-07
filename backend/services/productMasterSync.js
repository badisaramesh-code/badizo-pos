const crypto=require('node:crypto');
const {enqueue}=require('./syncOutbox');
const {insert}=require('./checkoutSyncHandler');
const {canonical}=require('./syncEventProtocol');
const ignored=new Set(['id','created_at','updated_at','previous_updated_at']);
async function read(connection,where,args,lock=false){const [rows]=await connection.query({sql:'SELECT * FROM products WHERE '+where+' ORDER BY id'+(lock?' FOR UPDATE':''),dateStrings:true,supportBigNumbers:true,bigNumberStrings:true},args);return JSON.parse(JSON.stringify(rows));}
async function beginProductCapture(connection,where,args,env=process.env){
  if(env.BADIZO_SYNC_PRODUCT_CAPTURE!=='true')return null;
  return {where,args,before:await read(connection,where,args,true)};
}
async function beginProductDeletion(connection,barcodes,env=process.env){
  if(env.BADIZO_SYNC_PRODUCT_CAPTURE!=='true')return null;
  const start=await beginProductCapture(connection,'barcode IN ('+barcodes.map(()=>'?').join(',')+')',barcodes,env);
  start.relations={};
  for(const row of start.before)start.relations[row.barcode]=await relations(connection,row.barcode,true);
  return start;
}
async function relations(connection,barcode,lock=false){
  const query=async(sql,args)=>{const [rows]=await connection.query({sql:sql+(lock?' FOR UPDATE':''),dateStrings:true,supportBigNumbers:true,bigNumberStrings:true},args);return JSON.parse(JSON.stringify(rows));};
  return {batches:await query('SELECT * FROM product_batches WHERE barcode=? ORDER BY id',[barcode]),offers:await query('SELECT * FROM batch_free_offers WHERE trigger_barcode=? OR free_barcode=? ORDER BY id',[barcode,barcode])};
}
async function finishProductCapture(connection,start,env=process.env){
  if(!start)return;
  const after=await read(connection,start.where,start.args);
  const identity={shopId:env.BADIZO_SHOP_ID,localInstallationId:env.BADIZO_INSTALLATION_ID,peerInstallationId:env.BADIZO_SYNC_PEER_INSTALLATION_ID};
  if(start.relations){
    if(after.length)throw Error('Product deletion did not remove the selected products.');
    const products=[];
    for(const before of start.before)products.push({before,beforeRelations:start.relations[before.barcode],afterRelations:await relations(connection,before.barcode)});
    if(products.length)await enqueue(connection,{eventId:crypto.randomUUID(),shopId:identity.shopId,originInstallationId:identity.localInstallationId,type:'pos.products.deleted',schemaVersion:1,payload:{products}},identity);
    return;
  }
  const beforeById=new Map(start.before.map(row=>[String(row.id),row]));
  const afterById=new Map(after.map(row=>[String(row.id),row]));
  const ids=new Set([...beforeById.keys(),...afterById.keys()]);
  for(const id of ids){
    const before=beforeById.get(id)||null,next=afterById.get(id)||null;
    const comparable=row=>row?Object.fromEntries(Object.entries(row).filter(([key])=>!ignored.has(key))):null;
    if(canonical(comparable(before))===canonical(comparable(next)))continue;
    const payload={before,after:next};
    await enqueue(connection,{eventId:crypto.randomUUID(),shopId:identity.shopId,originInstallationId:identity.localInstallationId,type:'pos.product.changed',schemaVersion:1,payload},identity);
  }
}
async function applyProductMaster(connection,payload){
  if(!payload||Object.keys(payload).some(key=>!['after','before'].includes(key))||!Object.hasOwn(payload,'before')||!Object.hasOwn(payload,'after')||(!payload.before&&!payload.after))throw Error('Invalid product master event.');
  const {before,after}=payload;
  for(const row of [before,after].filter(Boolean)){
    if(typeof row.barcode!=='string'||!row.barcode||row.barcode.length>120)throw Error('Invalid product barcode.');
    if(Object.values(row).some(value=>value!==null&&!['string','number','boolean'].includes(typeof value)))throw Error('Invalid product field value.');
  }
  const codes=[...new Set([before?.barcode,after?.barcode].filter(Boolean))].sort();
  const targets=await read(connection,'barcode IN ('+codes.map(()=>'?').join(',')+')',codes,true);
  const target=targets.find(row=>row.barcode===(before?.barcode||after.barcode));
  if(!before){if(target)throw Error('Product creation conflicts with an existing product.');await insert(connection,'products',after);return;}
  if(!target)throw Error('Product master baseline missing.');
  if(after&&before.barcode!==after.barcode&&targets.some(row=>row.barcode===after.barcode))throw Error('New product barcode is already in use.');
  const [schema]=await connection.query('SHOW COLUMNS FROM products');const allowed=new Set(schema.map(row=>row.Field));
  const fields=Object.keys(before).filter(field=>!ignored.has(field));
  if(fields.some(field=>!allowed.has(field)||!/^[a-z_][a-z0-9_]*$/.test(field)) || (after&&Object.keys(after).filter(field=>!ignored.has(field)).sort().join(',')!==[...fields].sort().join(',')))throw Error('Product schemas differ.');
  const changed=fields.filter(field=>!after||canonical(before[field])!==canonical(after[field]));
  for(const field of changed)if(canonical(target[field])!==canonical(before[field])){
    const error=Error('Product field changed on receiver; review required.');
    if(after && changed.every(name=>['product_name','sale_price'].includes(name)))error.recoveryFields=changed.map(name=>({kind:'product',recordId:before.barcode,field:name,base:before[name],local:target[name],cloud:after[name]}));
    throw error;
  }
  if(!after||before.barcode!==after.barcode){
    const [batches]=await connection.execute('SELECT id FROM product_batches WHERE barcode=? LIMIT 1 FOR UPDATE',[before.barcode]);
    if(batches.length)throw Error('Product deletion/rename has batch dependencies; review required.');
  }
  if(!after){await connection.execute('DELETE FROM products WHERE id=?',[target.id]);return;}
  if(changed.length)await connection.execute('UPDATE products SET '+changed.map(field=>'`'+field+'`=?').join(',')+',updated_at=CURRENT_TIMESTAMP WHERE id=?',[...changed.map(field=>after[field]),target.id]);
}
// Validate the entire deletion group before removing any shared batch offers.
// Shared offers may reference two deleted products, so per-product events are
// insufficient: the first event would otherwise invalidate the second.
async function applyProductDeletion(connection,payload){
  if(!payload||Object.keys(payload).join(',')!=='products'||!Array.isArray(payload.products)||!payload.products.length)throw Error('Invalid product deletion group.');
  const codes=payload.products.map(item=>item?.before?.barcode);
  if(codes.some(code=>typeof code!=='string'||!code||code.length>120)||new Set(codes).size!==codes.length)throw Error('Invalid product deletion identities.');
  const shape=row=>canonical(Object.fromEntries(Object.entries(row).filter(([field])=>!ignored.has(field))));
  const shapes=rows=>rows.map(shape).sort();
  const removals=[];const offersToDelete=new Set();
  for(const item of [...payload.products].sort((a,b)=>a.before.barcode.localeCompare(b.before.barcode))){
    const {before,beforeRelations,afterRelations}=item;
    const [current]=await read(connection,'barcode=?',[before.barcode],true);
    if(!current||shape(current)!==shape(before))throw Error('Product changed before deletion; review required.');
    const related=await relations(connection,before.barcode,true);
    for(const key of ['batches','offers']){
      if(!Array.isArray(beforeRelations?.[key])||!Array.isArray(afterRelations?.[key])||canonical(shapes(related[key]))!==canonical(shapes(beforeRelations[key])))throw Error('Product dependencies changed; review required.');
    }
    if(afterRelations.batches.length)throw Error('Product deletion left source batches.');
    const kept=new Set(shapes(afterRelations.offers));
    if([...kept].some(value=>!shapes(beforeRelations.offers).includes(value)))throw Error('Product deletion changed an offer.');
    for(const offer of related.offers)if(!kept.has(shape(offer)))offersToDelete.add(String(offer.id));
    removals.push(current);
  }
  for(const id of offersToDelete)await connection.execute('DELETE FROM batch_free_offers WHERE id=?',[id]);
  for(const row of removals){
    await connection.execute('DELETE FROM product_batches WHERE barcode=?',[row.barcode]);
    await connection.execute('DELETE FROM products WHERE id=?',[row.id]);
  }
}
module.exports={beginProductCapture,beginProductDeletion,finishProductCapture,applyProductMaster,applyProductDeletion};
