const fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto'),assert=require('node:assert/strict'),mysql=require('mysql2/promise');
const express=require('express'),jwt=require('jsonwebtoken');
const {JWT_SECRET}=require('../../backend/middleware/auth');
const {createRecoveryReviewStore}=require('../../backend/services/recoveryReviewStore');
const {createRecoveryConflictExecution}=require('../../backend/services/recoveryConflictExecution');
const {createRouter}=require('../../backend/routes/recoveryReview');
const {applyProductResolution}=require('../../backend/services/productConflictResolution');
const {createPosSyncReceiver}=require('../../backend/services/posSyncReceiver');
const {enqueue}=require('../../backend/services/syncOutbox');
const {createOutboxSender}=require('../../backend/services/syncOutbox');
const {createSyncReceiver}=require('../../backend/services/syncEventProtocol');
const {applyProductFields}=require('../../backend/services/productSyncHandler');
async function main(){
  const configs=await Promise.all(process.argv.slice(2).map(async name=>JSON.parse(await fs.readFile(name,'utf8'))));
  assert.equal(configs.length,2);assert.notEqual(configs[0].database,configs[1].database);
  for(const config of configs)assert.match(config.database,/^badizo_recovery_[a-z0-9]+$/);
  const pools=configs.map(config=>mysql.createPool({host:config.host,user:config.user,password:config.password,database:config.database,connectionLimit:4}));
  const [local,cloud]=pools;let server;
  try{
    const identity={shopId:'HFM001',localInstallationId:'review-'+crypto.randomUUID(),peerInstallationId:'review-peer'};
    const barcode='REVIEW'+crypto.randomBytes(10).toString('hex');
    for(const [index,pool] of pools.entries())await pool.execute('INSERT INTO products (barcode,product_name,sale_price,stock_qty) VALUES (?,?,?,?)',[barcode,'ISOLATED RECOVERY REVIEW',index?12:11,index?7:9]);
    const directory=await fs.mkdtemp(path.join(os.tmpdir(),'badizo-execution-'));
    const store=createRecoveryReviewStore({directory,shopId:identity.shopId});
    const initial=await store.create({shopId:identity.shopId,baselineId:crypto.randomUUID(),localCheckpoint:'L1',cloudCheckpoint:'C1',fields:[{kind:'product',recordId:barcode,field:'sale_price',base:'10.00',local:'11.00',cloud:'12.00'}]});
    const executor=createRecoveryConflictExecution({pool:local,store,identity,canApply:async()=>true});
    const app=express();app.use(express.json());app.use('/review',createRouter({store,shopId:identity.shopId,executor}));
    server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
    const base='http://127.0.0.1:'+server.address().port+'/review/'+initial.plan.id;
    async function post(suffix,body,role='SERVER'){return fetch(base+suffix,{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+jwt.sign({role,username:'isolated-owner'},JWT_SECRET)},body:JSON.stringify(body)});}
    const response=await post('/decisions',{expectedRevision:0,side:'local',conflictIds:[initial.plan.entries[0].id]});assert.equal(response.status,200);const review=await response.json();
    const request={expectedRevision:review.revision,expectedHeadHash:review.headHash,confirmation:'APPLY REVIEWED PRODUCT CHOICES'};
    assert.equal((await post('/apply',request,'ADMIN')).status,403);
    await local.execute('UPDATE products SET sale_price=13 WHERE barcode=?',[barcode]);
    assert.equal((await post('/apply',request)).status,409);
    assert.equal(await executor.status(initial.plan.id),null);
    await local.execute('UPDATE products SET sale_price=11 WHERE barcode=?',[barcode]);
    assert.equal((await post('/apply',request)).status,200);
    assert.equal((await post('/apply',request)).status,200);
    assert.equal((await post('/decisions',{expectedRevision:1,side:'cloud',conflictIds:[initial.plan.entries[0].id]})).status,409);
    const [[queued]]=await local.execute('SELECT COUNT(*) AS n FROM sync_outbox WHERE origin_installation_id=?',[identity.localInstallationId]);assert.equal(Number(queued.n),1);
    const receive=createSyncReceiver({pool:cloud,identity:{shopId:identity.shopId,peerInstallationId:identity.localInstallationId,localInstallationId:identity.peerInstallationId},handlers:{'pos.product.fields.changed':applyProductFields,'pos.recovery.product-resolved':applyProductResolution}});
    const send=createOutboxSender({pool:local,identity,send:receive});assert.equal((await send()).acknowledged,1);
    for(const [index,pool] of pools.entries()){const [[row]]=await pool.execute('SELECT sale_price,stock_qty FROM products WHERE barcode=?',[barcode]);assert.equal(Number(row.sale_price),11);assert.equal(Number(row.stock_qty),index?7:9);}
    const [[receipt]]=await local.execute('SELECT actor,review_json FROM sync_recovery_applications WHERE shop_id=? AND plan_id=?',[identity.shopId,initial.plan.id]);assert.equal(receipt.actor,'isolated-owner');assert.ok(receipt.review_json);
    const conflictBarcode='REVIEWQUEUE'+crypto.randomBytes(8).toString('hex');
    for(const [index,pool] of pools.entries())await pool.execute('INSERT INTO products (barcode,product_name,sale_price,stock_qty) VALUES (?,?,?,?)',[conflictBarcode,'QUEUED CONFLICT TEST',index?12:11,10]);
    const localEvent={eventId:crypto.randomUUID(),shopId:identity.shopId,originInstallationId:identity.localInstallationId,type:'pos.product.fields.changed',schemaVersion:1,payload:{barcode:conflictBarcode,changes:[{field:'sale_price',before:'10.00',after:'11.00'}]}};
    const cloudIdentity={shopId:identity.shopId,localInstallationId:identity.peerInstallationId,peerInstallationId:identity.localInstallationId};
    const cloudEvent={...localEvent,eventId:crypto.randomUUID(),originInstallationId:identity.peerInstallationId,payload:{barcode:conflictBarcode,changes:[{field:'sale_price',before:'10.00',after:'12.00'}]}};
    await enqueue(local,localEvent,identity);await enqueue(cloud,cloudEvent,cloudIdentity);
    const receiveLocal=createSyncReceiver({pool:local,identity:{shopId:identity.shopId,peerInstallationId:identity.peerInstallationId,localInstallationId:identity.localInstallationId},handlers:{'pos.product.fields.changed':applyProductFields,'pos.recovery.product-resolved':applyProductResolution},reviewStore:store});
    await assert.rejects(receiveLocal(cloudEvent),/resolve the new conflict/);
    const reviewItem=(await store.list()).find(item=>item.baselineId==='sync:'+cloudEvent.eventId);assert.ok(reviewItem);
    const incoming=await store.read(reviewItem.id);
    const chosen=await store.select(reviewItem.id,{expectedRevision:0,side:'cloud',actor:'owner',conflictIds:incoming.plan.entries.filter(item=>item.state==='conflict').map(item=>item.id)});
    await executor.apply(reviewItem.id,{expectedRevision:chosen.revision,expectedHeadHash:chosen.headHash,actor:'owner'});
    assert.equal((await send()).acknowledged,2);
    const cloudSend=createOutboxSender({pool:cloud,identity:cloudIdentity,send:receiveLocal});assert.equal((await cloudSend()).acknowledged,1);
    for(const pool of pools){const [[row]]=await pool.execute('SELECT sale_price FROM products WHERE barcode=?',[conflictBarcode]);assert.equal(Number(row.sale_price),12);}
    const emergencyBarcode='EMERGENCY'+crypto.randomBytes(8).toString('hex');
    for(const [index,pool] of pools.entries())await pool.execute('INSERT INTO products (barcode,product_name,sale_price,stock_qty) VALUES (?,?,?,?)',[emergencyBarcode,'EMERGENCY PRIORITY TEST',index?22:21,10]);
    const emergencyEvent={...cloudEvent,eventId:crypto.randomUUID(),payload:{barcode:emergencyBarcode,changes:[{field:'sale_price',before:'20.00',after:'22.00'}]}};
    await enqueue(cloud,emergencyEvent,cloudIdentity);
    const automatic=createPosSyncReceiver({pool:local,identity:{shopId:identity.shopId,localInstallationId:identity.localInstallationId,peerInstallationId:identity.peerInstallationId},reviewStore:store,localPriority:async()=>true});
    assert.equal((await automatic(emergencyEvent)).duplicate,true);assert.equal((await send()).acknowledged,1);assert.equal((await cloudSend()).acknowledged,1);
    for(const pool of pools){const [[row]]=await pool.execute('SELECT sale_price FROM products WHERE barcode=?',[emergencyBarcode]);assert.equal(Number(row.sale_price),21);}
    console.log(JSON.stringify({emergencyAutomaticallyPrefersLocal:true,manualCloudChoiceApplied:true,blockedIncomingEventReviewed:true,olderOutgoingEditCannotBlockResolution:true,bothQueuesDrainAfterResolution:true,ownerApiApplied:true,stalePreviewBlocked:true,retryDidNotDuplicate:true,appliedReviewImmutable:true,localChoiceReachedCloud:true,bothStockValuesPreserved:true,durableAudit:true,productionModified:false}));
  }finally{if(server)await new Promise(resolve=>server.close(resolve));await Promise.all(pools.map(pool=>pool.end()));}
}
main().catch(error=>{console.error('Conflict execution drill failed: '+error.message);process.exitCode=1;});
