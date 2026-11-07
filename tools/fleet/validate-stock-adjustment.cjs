const fs=require('node:fs'),crypto=require('node:crypto'),assert=require('node:assert/strict'),{spawn}=require('node:child_process'),mysql=require('mysql2/promise');
const {createSyncReceiver}=require('../../backend/services/syncEventProtocol');
const {applyStockAdjustment}=require('../../backend/services/stockAdjustmentSync');
async function main(){
  assert.equal(process.env.DB_NAME,'badizo_cloud_validation');
  const config=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));assert.match(config.database,/^badizo_recovery_[a-z0-9]+$/);
  const source=await mysql.createConnection({host:process.env.DB_HOST,user:process.env.DB_USER,password:process.env.DB_PASSWORD,database:process.env.DB_NAME});
  const target=mysql.createPool({host:config.host,user:config.user,password:config.password,database:config.database,connectionLimit:2});let child,log;
  try{
    const password=crypto.randomBytes(24).toString('hex'),salt=crypto.randomBytes(16).toString('hex');
    const hash=salt+':'+crypto.pbkdf2Sync(password,salt,100000,64,'sha512').toString('hex');
    await source.execute("INSERT INTO users(username,password_hash,role,counter_no,is_active) VALUES('sync_stock_validation',?,'SERVER',1,1) ON DUPLICATE KEY UPDATE password_hash=VALUES(password_hash),is_active=1",[hash]);
    const [[product]]=await source.query('SELECT p.barcode,p.stock_qty FROM products p WHERE p.stock_qty>100 AND NOT EXISTS (SELECT 1 FROM product_batches b WHERE b.barcode=p.barcode) LIMIT 1');assert.ok(product);
    const [[before]]=await target.execute('SELECT stock_qty FROM products WHERE barcode=?',[product.barcode]);assert.ok(Number(before.stock_qty)>10);
    log=fs.openSync('/var/lib/badizo/validation-server.log','a',0o600);
    child=spawn(process.execPath,['server.js'],{cwd:process.cwd(),env:{...process.env,BADIZO_DB_BOOTSTRAP:'false',BADIZO_SMS_ENABLED:'false',BADIZO_WHATSAPP_ENABLED:'false'},stdio:['ignore',log,log]});
    let ready=false;for(let i=0;i<40;i++){try{if((await fetch('http://127.0.0.1:5001/api/ready')).ok){ready=true;break;}}catch{}await new Promise(resolve=>setTimeout(resolve,250));}assert.ok(ready);
    const login=await fetch('http://127.0.0.1:5001/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:'sync_stock_validation',password})});assert.equal(login.status,200);
    const {token}=await login.json(),headers={'Content-Type':'application/json',Authorization:'Bearer '+token};
    const rejectNote='STOCK_QUEUE_FAILURE_'+crypto.randomBytes(8).toString('hex');
    const constraint='validation_stock_'+crypto.randomBytes(6).toString('hex');
    await source.query("ALTER TABLE sync_outbox ADD CONSTRAINT "+constraint+" CHECK (JSON_UNQUOTE(JSON_EXTRACT(event_json,'$.payload.adjustment.note')) <> '"+rejectNote+"')");
    try{
      const rejected=await fetch('http://127.0.0.1:5001/api/products/stock-adjustments',{method:'POST',headers,body:JSON.stringify({barcode:product.barcode,adjustment_qty:-1,reason:'OTHER',note:rejectNote})});assert.equal(rejected.status,500);
      const [[stock]]=await source.execute('SELECT stock_qty FROM products WHERE barcode=?',[product.barcode]);assert.equal(String(stock.stock_qty),String(product.stock_qty));
      const [[rows]]=await source.execute('SELECT COUNT(*) AS n FROM stock_adjustments WHERE note=?',[rejectNote]);assert.equal(Number(rows.n),0);
    }finally{await source.query('ALTER TABLE sync_outbox DROP CHECK '+constraint);}
    for(const delta of [-1,1]){
      const response=await fetch('http://127.0.0.1:5001/api/products/stock-adjustments',{method:'POST',headers,body:JSON.stringify({barcode:product.barcode,adjustment_qty:delta,reason:delta<0?'DAMAGE':'OTHER',note:'ISOLATED SYNC VALIDATION'})});assert.equal(response.status,200);const saved=await response.json();
      const [[row]]=await source.execute("SELECT event_json FROM sync_outbox WHERE JSON_UNQUOTE(JSON_EXTRACT(event_json,'$.type'))='pos.stock.adjusted' AND JSON_UNQUOTE(JSON_EXTRACT(event_json,'$.payload.adjustment.id'))=?",[String(saved.adjustmentId)]);assert.ok(row);
      const event=typeof row.event_json==='string'?JSON.parse(row.event_json):row.event_json;
      const identity={shopId:event.shopId,peerInstallationId:event.originInstallationId,localInstallationId:'validation-receiver'};
      const receive=createSyncReceiver({pool:target,identity,handlers:{'pos.stock.adjusted':applyStockAdjustment}});
      const [[start]]=await target.execute('SELECT stock_qty FROM products WHERE barcode=?',[product.barcode]);
      const fail=createSyncReceiver({pool:target,identity,handlers:{'pos.stock.adjusted':async(...args)=>{await applyStockAdjustment(...args);throw Error('Injected stock failure');}}});
      await assert.rejects(fail(event),/Injected stock failure/);
      const [[rolledBack]]=await target.execute('SELECT stock_qty FROM products WHERE barcode=?',[product.barcode]);assert.equal(String(rolledBack.stock_qty),String(start.stock_qty));
      const [[receipt]]=await target.execute('SELECT COUNT(*) AS n FROM sync_inbox WHERE event_id=?',[event.eventId]);assert.equal(Number(receipt.n),0);
      assert.equal((await receive(event)).duplicate,false);assert.equal((await receive(event)).duplicate,true);
      const [[after]]=await target.execute('SELECT stock_qty FROM products WHERE barcode=?',[product.barcode]);assert.equal(Number(after.stock_qty),Number(start.stock_qty)+delta);
      const reissued={...event,eventId:crypto.randomUUID()};await assert.rejects(receive(reissued));
      const [[reissuedReceipt]]=await target.execute('SELECT COUNT(*) AS n FROM sync_inbox WHERE event_id=?',[reissued.eventId]);assert.equal(Number(reissuedReceipt.n),0);
      const audit=structuredClone(event);audit.eventId=crypto.randomUUID();audit.payload.adjustment.reason='STOCK_AUDIT';audit.payload.adjustment.old_qty=String(Number(after.stock_qty)+5);audit.payload.adjustment.adjustment_qty='1';audit.payload.adjustment.new_qty=String(Number(after.stock_qty)+6);
      await assert.rejects(receive(audit),/Stock audit conflicts/);
      const [[mapping]]=await target.execute('SELECT target_adjustment_id FROM sync_stock_adjustment_map WHERE shop_id=? AND origin_installation_id=? AND source_adjustment_id=?',[event.shopId,event.originInstallationId,String(saved.adjustmentId)]);assert.ok(mapping.target_adjustment_id);
      const [[ledger]]=await target.execute('SELECT old_qty,new_qty,adjustment_qty FROM stock_adjustments WHERE id=?',[mapping.target_adjustment_id]);assert.equal(Number(ledger.old_qty),Number(start.stock_qty));assert.equal(Number(ledger.new_qty),Number(after.stock_qty));assert.equal(Number(ledger.adjustment_qty),delta);
    }
    const [[sourceAfter]]=await source.execute('SELECT stock_qty FROM products WHERE barcode=?',[product.barcode]);assert.equal(String(sourceAfter.stock_qty),String(product.stock_qty));
    const [[targetAfter]]=await target.execute('SELECT stock_qty FROM products WHERE barcode=?',[product.barcode]);assert.equal(String(targetAfter.stock_qty),String(before.stock_qty));
    console.log(JSON.stringify({realAdjustmentApiCaptured:true,sourceQueueFailureRollsBackAdjustment:true,deltaAppliedWithoutSnapshotOverwrite:true,duplicateAndReissuedIdentityProtected:true,receiptStockAndLedgerRollbackTogether:true,conflictingAuditBlocked:true,sourceAndTargetStockRestored:true,productionModified:false}));
  }finally{
    if(child&&child.exitCode===null&&child.signalCode===null){const stopped=new Promise(resolve=>child.once('exit',resolve));child.kill('SIGTERM');await stopped;}
    if(log!==undefined)fs.closeSync(log);await source.end();await target.end();
  }
}
main().catch(error=>{console.error('Isolated stock adjustment drill failed: '+error.message);process.exitCode=1;});
