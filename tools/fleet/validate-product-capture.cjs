const fs=require('node:fs/promises'),assert=require('node:assert/strict'),crypto=require('node:crypto'),mysql=require('mysql2/promise');
const {updatePriceListWithCapture}=require('../../backend/services/productSyncCapture');
const {createOutboxSender}=require('../../backend/services/syncOutbox');
const {createSyncReceiver}=require('../../backend/services/syncEventProtocol');
const {applyProductFields}=require('../../backend/services/productSyncHandler');
async function main(){
  const configs=await Promise.all(process.argv.slice(2).map(async file=>JSON.parse(await fs.readFile(file,'utf8'))));assert.equal(configs.length,2);assert.notEqual(configs[0].database,configs[1].database);
  for(const config of configs)assert.match(config.database,/^badizo_recovery_[a-z0-9]+$/);
  const pools=configs.map(c=>mysql.createPool({host:c.host,user:c.user,password:c.password,database:c.database,connectionLimit:3}));const [source,target]=pools;
  const identity={shopId:'HFM001',localInstallationId:'price-'+crypto.randomUUID(),peerInstallationId:'price-receiver'};
  const env={BADIZO_SYNC_PRODUCT_CAPTURE:'true',BADIZO_SHOP_ID:identity.shopId,BADIZO_INSTALLATION_ID:identity.localInstallationId,BADIZO_SYNC_PEER_INSTALLATION_ID:identity.peerInstallationId};
  let original;
  try{
    const [[product]]=await source.query('SELECT id,barcode,sale_price,stock_qty FROM products WHERE sale_price BETWEEN 1 AND 1000 ORDER BY id LIMIT 1');assert.ok(product);original=product;
    const [[peer]]=await target.execute('SELECT sale_price,stock_qty FROM products WHERE barcode=?',[product.barcode]);assert.equal(String(peer.sale_price),String(product.sale_price));
    const changed=(Number(product.sale_price)+0.01).toFixed(2);
    async function update(value,rollback=false){const connection=await source.getConnection();try{await connection.beginTransaction();await updatePriceListWithCapture(connection,{sql:'UPDATE products SET sale_price=? WHERE id=?',values:[value,product.id]},[product.id],'sale_price',env);if(rollback)await connection.rollback();else await connection.commit();}catch(error){await connection.rollback();throw error;}finally{connection.release();}}
    await update(changed,true);
    const [[pending]]=await source.execute('SELECT COUNT(*) AS n FROM sync_outbox WHERE origin_installation_id=?',[identity.localInstallationId]);assert.equal(Number(pending.n),0);
    const [[rolledBack]]=await source.execute('SELECT sale_price FROM products WHERE id=?',[product.id]);assert.equal(String(rolledBack.sale_price),String(product.sale_price));
    const receive=createSyncReceiver({pool:target,identity:{shopId:identity.shopId,peerInstallationId:identity.localInstallationId,localInstallationId:identity.peerInstallationId},handlers:{'pos.product.fields.changed':applyProductFields}});
    let drop=true;const flush=createOutboxSender({pool:source,identity,send:async event=>{const result=await receive(event);if(drop){drop=false;throw Error('Lost price acknowledgment');}return result;}});
    await update(changed);await assert.rejects(flush(),/Lost price acknowledgment/);assert.equal((await flush()).acknowledged,1);
    const [[updated]]=await target.execute('SELECT sale_price,stock_qty FROM products WHERE barcode=?',[product.barcode]);assert.equal(String(updated.sale_price),changed);assert.equal(String(updated.stock_qty),String(peer.stock_qty));
    await update(product.sale_price);assert.equal((await flush()).acknowledged,1);
    const [[restored]]=await target.execute('SELECT sale_price FROM products WHERE barcode=?',[product.barcode]);assert.equal(String(restored.sale_price),String(product.sale_price));
    original=null;
    console.log(JSON.stringify({priceChangeCapturedAndApplied:true,sourceRollbackRemovesEvent:true,lostAckRetried:true,stockUnchanged:true,originalPricesRestored:true,productionModified:false}));
  }finally{
    // Restore the isolated source value if a failure interrupts the drill. Target
    // failed state is retained for investigation, never overwritten blindly.
    if(original)await source.execute('UPDATE products SET sale_price=? WHERE id=?',[original.sale_price,original.id]);
    await Promise.all(pools.map(pool=>pool.end()));
  }
}
main().catch(error=>{console.error('Isolated product capture drill failed: '+error.message);process.exitCode=1;});
