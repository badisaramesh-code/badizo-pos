const fs=require('node:fs/promises'),https=require('node:https'),crypto=require('node:crypto'),assert=require('node:assert/strict'),express=require('express'),mysql=require('mysql2/promise');
const {enqueue}=require('../../backend/services/syncOutbox');
const {createSyncReceiver}=require('../../backend/services/syncEventProtocol');
const {createOutgoingFeed}=require('../../backend/services/syncOutgoingFeed');
const {createSyncPullClient}=require('../../backend/services/syncPullClient');
const {createSyncHttpTransport}=require('../../backend/services/syncHttpTransport');
const {createCloudSyncRuntime}=require('../../backend/services/cloudSyncRuntime');
const {createRouter:feedRouter}=require('../../backend/routes/syncFeed');
const {createRouter:receiverRouter}=require('../../backend/routes/syncReceiver');
async function main(){
  const [cloudFile,localFile,keyFile,certFile]=process.argv.slice(2);
  const configs=await Promise.all([cloudFile,localFile].map(async file=>JSON.parse(await fs.readFile(file,'utf8'))));
  for(const config of configs)assert.match(config.database,/^badizo_recovery_[a-z0-9]+$/);assert.notEqual(configs[0].database,configs[1].database);
  const pools=configs.map(c=>mysql.createPool({host:c.host,user:c.user,password:c.password,database:c.database,connectionLimit:5}));const [cloud,local]=pools;
  const run=crypto.randomUUID(),token=crypto.randomBytes(32).toString('hex');let server;
  const localIdentity={shopId:'HFM001',localInstallationId:'local-'+run,peerInstallationId:'cloud-'+run};
  const cloudIdentity={shopId:'HFM001',localInstallationId:localIdentity.peerInstallationId,peerInstallationId:localIdentity.localInstallationId};
  let rejectLocal=true,loseAck=true,now=Date.now();
  const handler=async(c,p,m)=>c.execute('INSERT INTO sync_validation_entries (event_id,amount) VALUES (?,?)',[m.eventId,p.amount]);
  try{
    const feed=createOutgoingFeed({pool:cloud,identity:cloudIdentity});
    const receiveLocal=createSyncReceiver({pool:local,identity:localIdentity,handlers:{'validation.sale':async(...args)=>{if(rejectLocal)throw Error('Injected local application failure');return handler(...args);}}});
    const receiveCloud=createSyncReceiver({pool:cloud,identity:cloudIdentity,handlers:{'validation.sale':handler}});
    const app=express();app.use('/feed',feedRouter({token,mayShare:async()=>true,feed:{pending:feed.pending,acknowledge:async value=>{if(loseAck){loseAck=false;throw Error('Simulated lost acknowledgment');}return feed.acknowledge(value);}}}));
    app.use('/receive',receiverRouter({token,receive:receiveCloud,mayReceive:async()=>true}));
    server=https.createServer({key:await fs.readFile(keyFile),cert:await fs.readFile(certFile)},app).listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
    const base=`https://127.0.0.1:${server.address().port}`;
    const event=(origin,amount)=>({eventId:crypto.randomUUID(),shopId:'HFM001',originInstallationId:origin,type:'validation.sale',schemaVersion:1,payload:{amount}});
    const cloudEvent=event(cloudIdentity.localInstallationId,20),localEvent=event(localIdentity.localInstallationId,30);
    await enqueue(cloud,cloudEvent,cloudIdentity);await enqueue(local,localEvent,localIdentity);
    const pullOptions={pool:local,identity:localIdentity,url:base+'/feed',token,receive:receiveLocal,mayApply:async()=>true};
    await assert.rejects(createSyncPullClient({...pullOptions,token:'0'.repeat(64)})());
    await assert.rejects(createSyncPullClient({...pullOptions,identity:{...localIdentity,shopId:'HFM002'}})());
    await assert.rejects(createSyncPullClient({...pullOptions,mayApply:async()=>false})());
    const options={pool:local,identity:localIdentity,send:createSyncHttpTransport({url:base+'/receive',token}),pull:createSyncPullClient(pullOptions),canTransfer:async()=>true,clock:()=>now,configDirectory:'/var/lib/badizo/duplex-validation-'+run};
    let runtime=createCloudSyncRuntime(options);
    assert.equal((await runtime.settings.state()).service.direction,'two-way');
    await runtime.settings.requestNow({username:'validation-owner'});
    assert.equal((await runtime.worker.tick()).failed,true);
    const [[failed]]=await local.execute('SELECT COUNT(*) AS n FROM sync_inbox WHERE event_id=?',[cloudEvent.eventId]);assert.equal(Number(failed.n),0);
    rejectLocal=false;now+=30000;assert.equal((await runtime.worker.tick()).failed,true);
    const [[committed]]=await local.execute('SELECT COUNT(*) AS n FROM sync_validation_entries WHERE event_id=?',[cloudEvent.eventId]);assert.equal(Number(committed.n),1);
    assert.equal((await feed.pending()).events.length,1);
    runtime=createCloudSyncRuntime(options);now+=60000;
    assert.equal((await runtime.worker.tick()).acknowledged,2);
    assert.equal((await feed.pending()).events.length,0);
    for(const [pool,e] of [[local,cloudEvent],[cloud,localEvent]]){const [[row]]=await pool.execute('SELECT COUNT(*) AS n,SUM(amount) AS amount FROM sync_validation_entries WHERE event_id=?',[e.eventId]);assert.equal(Number(row.n),1);assert.equal(Number(row.amount),e.payload.amount);}
    await assert.rejects(feed.acknowledge({eventId:cloudEvent.eventId,hash:'0'.repeat(64)}));
    const [[echo]]=await local.execute('SELECT COUNT(*) AS n FROM sync_outbox WHERE event_id=?',[cloudEvent.eventId]);assert.equal(Number(echo.n),0);
    assert.equal((await runtime.settings.state()).manualPending,false);
    console.log(JSON.stringify({verifiedHttps:true,bothDirectionsApplied:true,localFailureDoesNotAcknowledgeCloud:true,lostAckRetriedAfterRestart:true,noDuplicateSale:true,noIncomingEcho:true,wrongTokenAndShopBlocked:true,permissionRequired:true,forgedAckRejected:true,productionModified:false}));
  }finally{if(server)await new Promise(resolve=>server.close(resolve));await Promise.all(pools.map(pool=>pool.end()));}
}
main().catch(error=>{console.error('Isolated duplex validation failed: '+error.message);process.exitCode=1;});
