const fs=require('node:fs/promises'),crypto=require('node:crypto'),assert=require('node:assert/strict'),mysql=require('mysql2/promise');
const {createSyncReceiver}=require('../../backend/services/syncEventProtocol');
const {applyProductFields}=require('../../backend/services/productSyncHandler');
async function main(){
  const config=JSON.parse(await fs.readFile(process.argv[2],'utf8'));assert.match(config.database,/^badizo_recovery_[a-z0-9]+$/);
  const pool=mysql.createPool({host:config.host,user:config.user,password:config.password,database:config.database,connectionLimit:2});
  try{
    const [[product]]=await pool.query('SELECT barcode,sale_price,stock_qty FROM products WHERE sale_price BETWEEN 1 AND 100000 LIMIT 1');assert.ok(product);
    const original=String(product.sale_price),changed=(Number(original)+1).toFixed(2);
    const receive=createSyncReceiver({pool,identity:{shopId:'HFM001',peerInstallationId:'drill-local',localInstallationId:'drill-cloud'},handlers:{'pos.product.fields.resolved':applyProductFields}});
    const event=(before,after)=>({eventId:crypto.randomUUID(),shopId:'HFM001',originInstallationId:'drill-local',type:'pos.product.fields.resolved',schemaVersion:1,payload:{barcode:product.barcode,changes:[{field:'sale_price',before,after}]}});
    const update=event(original,changed);assert.equal((await receive(update)).duplicate,false);assert.equal((await receive(update)).duplicate,true);
    const [[current]]=await pool.execute('SELECT sale_price,stock_qty FROM products WHERE barcode=?',[product.barcode]);assert.equal(String(current.sale_price),changed);assert.equal(String(current.stock_qty),String(product.stock_qty));
    const stale=event(original,'1.00');await assert.rejects(receive(stale));
    const [[receipt]]=await pool.execute('SELECT COUNT(*) AS n FROM sync_inbox WHERE event_id=?',[stale.eventId]);assert.equal(Number(receipt.n),0);
    await receive(event(changed,original));
    const [[restored]]=await pool.execute('SELECT sale_price FROM products WHERE barcode=?',[product.barcode]);assert.equal(String(restored.sale_price),original);
    console.log(JSON.stringify({realProductUpdated:true,duplicateAppliedOnce:true,staleEditRejected:true,failedReceiptRolledBack:true,stockUnchanged:true,originalPriceRestored:true,productionModified:false}));
  }finally{await pool.end();}
}
main().catch(()=>{console.error('Isolated product application drill failed; inspect validation database.');process.exitCode=1;});
