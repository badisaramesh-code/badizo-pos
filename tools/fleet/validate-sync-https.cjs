const fs=require('node:fs/promises'),https=require('node:https'),crypto=require('node:crypto'),assert=require('node:assert/strict'),express=require('express'),mysql=require('mysql2/promise');
const {enqueue,createOutboxSender}=require('../../backend/services/syncOutbox');
const {createSyncReceiver}=require('../../backend/services/syncEventProtocol');
const {createSyncHttpTransport}=require('../../backend/services/syncHttpTransport');
const {createRouter}=require('../../backend/routes/syncReceiver');
async function main(){
  const [sourceFile,targetFile,keyFile,certFile]=process.argv.slice(2);
  const configs=await Promise.all([sourceFile,targetFile].map(async file=>JSON.parse(await fs.readFile(file,'utf8'))));
  for(const config of configs)assert.match(config.database,/^badizo_recovery_[a-z0-9]+$/);
  assert.notEqual(configs[0].database,configs[1].database);
  const pools=configs.map(c=>mysql.createPool({host:c.host,user:c.user,password:c.password,database:c.database,connectionLimit:3}));
  const [source,target]=pools,token=crypto.randomBytes(32).toString('hex');let server;
  try{
    const identity={shopId:'HFM001',localInstallationId:'drill-local',peerInstallationId:'drill-cloud'};
    const receive=createSyncReceiver({pool:target,identity:{shopId:'HFM001',peerInstallationId:'drill-local',localInstallationId:'drill-cloud'},handlers:{'validation.sale':async(c,p,m)=>c.execute('INSERT INTO sync_validation_entries (event_id,amount) VALUES (?,?)',[m.eventId,p.amount])}});
    const app=express();app.use('/sync',createRouter({token,receive,mayReceive:async()=>true}));
    server=https.createServer({key:await fs.readFile(keyFile),cert:await fs.readFile(certFile)},app).listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
    const url=`https://127.0.0.1:${server.address().port}/sync`,send=createSyncHttpTransport({url,token});
    const event={eventId:crypto.randomUUID(),shopId:'HFM001',originInstallationId:'drill-local',type:'validation.sale',schemaVersion:1,payload:{amount:15}};
    await assert.rejects(createSyncHttpTransport({url,token:'0'.repeat(64)})(event));
    await assert.rejects(send({...event,shopId:'HFM002'}));
    const connection=await source.getConnection();
    try{await connection.beginTransaction();await enqueue(connection,event,identity);await connection.commit();}finally{connection.release();}
    let lose=true;const flush=createOutboxSender({pool:source,identity,send:async e=>{const result=await send(e);if(lose){lose=false;throw Error('Lost acknowledgment');}return result;}});
    await assert.rejects(flush());assert.equal((await flush()).acknowledged,1);
    const [rows]=await target.execute('SELECT COUNT(*) AS n,SUM(amount) AS amount FROM sync_validation_entries WHERE event_id=?',[event.eventId]);assert.equal(Number(rows[0].n),1);assert.equal(Number(rows[0].amount),15);
    console.log(JSON.stringify({httpsCertificateVerified:true,realMysql:true,invalidTokenDenied:true,crossShopEventDenied:true,lostAcknowledgmentRetried:true,appliedExactlyOnce:true,productionModified:false}));
  }finally{if(server)await new Promise(resolve=>server.close(resolve));await Promise.all(pools.map(pool=>pool.end()));}
}
main().catch(()=>{console.error('Isolated HTTPS/MySQL sync validation failed.');process.exitCode=1;});
