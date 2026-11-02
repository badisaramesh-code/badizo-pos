const crypto=require('node:crypto');
const {enqueue}=require('./syncOutbox');
const {normalize}=require('./productSyncHandler');

// Caller owns the transaction. With capture disabled, execute the original
// query directly: no additional queries or schema requirements on local POS.
async function updatePriceListWithCapture(connection,update,ids,property,env=process.env){
  if(env.BADIZO_SYNC_PRODUCT_CAPTURE!=='true' || !['sale_price','product_name'].includes(property))return connection.query(update.sql,update.values);
  if(!Array.isArray(ids)||!ids.length||ids.some(id=>!/^\d+$/.test(String(id))))throw Error('Invalid product identities for capture.');
  const identity={shopId:env.BADIZO_SHOP_ID,localInstallationId:env.BADIZO_INSTALLATION_ID,peerInstallationId:env.BADIZO_SYNC_PEER_INSTALLATION_ID};
  const placeholders=ids.map(()=>'?').join(',');
  // Read the actual before-value under the same lock as the mutation, rather
  // than using a price-list preview that another counter may have changed.
  const [before]=await connection.query(`SELECT id,barcode,product_name,sale_price FROM products WHERE id IN (${placeholders}) ORDER BY id FOR UPDATE`,ids);
  const result=await connection.query(update.sql,update.values);
  const [after]=await connection.query(`SELECT id,barcode,product_name,sale_price FROM products WHERE id IN (${placeholders}) ORDER BY id`,ids);
  if(before.length!==after.length)throw Error('Product set changed during capture.');
  for(const old of before){
    const current=after.find(row=>String(row.id)===String(old.id));
    if(!current || current.barcode!==old.barcode)throw Error('Product identity changed during capture.');
    const prior=normalize(property,old[property]),next=normalize(property,current[property]);
    if(prior===next)continue;
    await enqueue(connection,{eventId:crypto.randomUUID(),shopId:identity.shopId,originInstallationId:identity.localInstallationId,type:'pos.product.fields.changed',schemaVersion:1,payload:{barcode:old.barcode,changes:[{field:property,before:prior,after:next}]}},identity);
  }
  return result;
}
module.exports={updatePriceListWithCapture};
