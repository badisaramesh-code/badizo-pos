const fs=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto'),assert=require('node:assert/strict'),mysql=require('mysql2/promise');
const {enqueue}=require('../../backend/services/syncOutbox');
const {createSyncReceiver}=require('../../backend/services/syncEventProtocol');
const {createCloudSyncRuntime}=require('../../backend/services/cloudSyncRuntime');
async function main(){
  const configurations=await Promise.all(process.argv.slice(2).map(async file=>JSON.parse(await fs.readFile(file,'utf8'))));
  assert.equal(configurations.length,2);assert.notEqual(configurations[0].database,configurations[1].database);
  for(const config of configurations)assert.match(config.database,/^badizo_recovery_[a-z0-9]+$/);
  const pools=configurations.map(config=>mysql.createPool({host:config.host,user:config.user,password:config.password,database:config.database,connectionLimit:4}));
  const [source,target]=pools;
  const runId=crypto.randomUUID();
  const configDirectory=path.join('/var/lib/badizo','worker-validation-'+runId);
  const identity={shopId:'HFM001',localInstallationId:'worker-'+runId,peerInstallationId:'worker-cloud'};
  let now=Date.parse('2026-11-02T14:59:00Z'),lost=true,permitted=true,deliveries=0;
  try{
    const receive=createSyncReceiver({pool:target,identity:{shopId:identity.shopId,peerInstallationId:identity.localInstallationId,localInstallationId:identity.peerInstallationId},handlers:{'validation.sale':async(c,p,m)=>c.execute('INSERT INTO sync_validation_entries (event_id,amount) VALUES (?,?)',[m.eventId,p.amount])}});
    const options={pool:source,identity,configDirectory,clock:()=>now,canTransfer:async()=>permitted,send:async event=>{deliveries++;const result=await receive(event);if(lost){lost=false;throw Error('Simulated lost acknowledgment');}return result;}};
    let runtime=createCloudSyncRuntime(options);
    await runtime.settings.save({enabled:true,frequency:'daily',dailyTime:'20:30',timezone:'Asia/Kolkata'},{username:'validation-owner'});
    const event={eventId:crypto.randomUUID(),shopId:identity.shopId,originInstallationId:identity.localInstallationId,type:'validation.sale',schemaVersion:1,payload:{amount:10}};
    const connection=await source.getConnection();try{await connection.beginTransaction();await enqueue(connection,event,identity);await connection.commit();}finally{connection.release();}
    assert.equal((await runtime.worker.tick()).waiting,true);assert.equal(deliveries,0);
    now+=60000;assert.equal((await runtime.worker.tick()).failed,true);assert.equal(deliveries,1);
    assert.equal((await runtime.settings.state()).service.state,'retrying');
    runtime=createCloudSyncRuntime(options); // Restart, retaining SQL/file state.
    now+=29999;assert.equal((await runtime.worker.tick()).waiting,true);assert.equal(deliveries,1);
    now++;assert.equal((await runtime.worker.tick()).acknowledged,1);assert.equal(deliveries,2);
    const [[applied]]=await target.execute('SELECT COUNT(*) AS n FROM sync_validation_entries WHERE event_id=?',[event.eventId]);assert.equal(Number(applied.n),1);
    assert.equal((await runtime.settings.state()).lastSuccessAt,new Date(now).toISOString());
    await runtime.settings.save({enabled:false,frequency:'hourly',dailyTime:'20:30',timezone:'Asia/Kolkata'},{username:'validation-owner'});
    now+=3600000;assert.equal((await runtime.worker.tick()).skipped,true);
    await runtime.settings.requestNow({username:'validation-owner'});assert.equal((await runtime.settings.state()).manualPending,true);
    assert.equal((await runtime.worker.tick()).acknowledged,0);assert.equal((await runtime.settings.state()).manualPending,false);
    // A request received during a run must not be cleared by that run's completion.
    let requested=false;
    const raced=createCloudSyncRuntime({...options,send:async event=>{if(!requested){requested=true;assert.equal((await runtime.worker.tick()).busy,true);await runtime.settings.requestNow({username:'second-owner'});}return receive(event);}});
    const next={...event,eventId:crypto.randomUUID()};await enqueue(source,next,identity);
    await runtime.settings.requestNow({username:'validation-owner'});
    await raced.worker.tick();assert.equal((await runtime.settings.state()).manualPending,true);
    await runtime.worker.tick();assert.equal((await runtime.settings.state()).manualPending,false);
    await runtime.settings.save({enabled:true,frequency:'hourly',dailyTime:'20:30',timezone:'Asia/Kolkata'},{username:'validation-owner'});
    assert.equal((await runtime.worker.tick()).waiting,true);now+=3600000;
    assert.equal((await runtime.worker.tick()).acknowledged,0);
    permitted=false;await assert.rejects(runtime.settings.requestNow({username:'validation-owner'}));assert.equal((await runtime.worker.tick()).skipped,true);
    console.log(JSON.stringify({dailyScheduleExecuted:true,hourlyScheduleExecuted:true,concurrentWorkerExcluded:true,restartRetainsBackoff:true,lostAckExactlyOnce:true,pausedScheduleRespected:true,manualUpdateWhilePaused:true,requestDuringRunRetained:true,permissionRevocationBlocksTransfer:true,productionModified:false}));
  }finally{await Promise.all(pools.map(pool=>pool.end()));}
}
main().catch(error=>{console.error('Isolated sync worker drill failed: '+error.message);process.exitCode=1;});
