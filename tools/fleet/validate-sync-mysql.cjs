const fs=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto'),assert=require('node:assert/strict'),mysql=require('mysql2/promise');
const {enqueue,createOutboxSender}=require('../../backend/services/syncOutbox');
const {createSyncReceiver}=require('../../backend/services/syncEventProtocol');
async function main(){
  const configurations=await Promise.all(process.argv.slice(2).map(async file=>JSON.parse(await fs.readFile(file,'utf8'))));
  assert.equal(configurations.length,2);assert.notEqual(configurations[0].database,configurations[1].database);
  for(const config of configurations)assert.match(config.database,/^badizo_recovery_[a-z0-9]+$/);
  const pools=configurations.map(config=>mysql.createPool({host:config.host,user:config.user,password:config.password,database:config.database,connectionLimit:3}));
  const [source,target]=pools;
  try{
    await source.query(await fs.readFile(path.resolve(__dirname,'../../database/migrations/optional-sync-outbox.sql'),'utf8'));
    await target.query(await fs.readFile(path.resolve(__dirname,'../../database/migrations/optional-sync-inbox.sql'),'utf8'));
    await target.query('CREATE TABLE sync_validation_entries (event_id CHAR(36) PRIMARY KEY, amount INT NOT NULL) ENGINE=InnoDB');
    const identity={shopId:'HFM001',localInstallationId:'drill-local',peerInstallationId:'drill-cloud'};
    const event={eventId:crypto.randomUUID(),shopId:'HFM001',originInstallationId:'drill-local',type:'validation.sale',schemaVersion:1,payload:{amount:10}};
    const connection=await source.getConnection();
    try{
      await connection.beginTransaction();await enqueue(connection,event,identity);await connection.rollback();
      const [counts]=await source.query('SELECT COUNT(*) AS n FROM sync_outbox');assert.equal(Number(counts[0].n),0);
      await connection.beginTransaction();await enqueue(connection,event,identity);await connection.commit();
    }finally{connection.release();}
    const receive=createSyncReceiver({pool:target,identity:{shopId:'HFM001',peerInstallationId:'drill-local',localInstallationId:'drill-cloud'},handlers:{'validation.sale':async(c,payload,metadata)=>c.execute('INSERT INTO sync_validation_entries (event_id,amount) VALUES (?,?)',[metadata.eventId,payload.amount])}});
    let lost=true;
    const flush=createOutboxSender({pool:source,identity,send:async e=>{const result=await receive(e);if(lost){lost=false;throw Error('Simulated lost acknowledgment');}return result;}});
    await assert.rejects(flush());
    const [pending]=await source.query('SELECT COUNT(*) AS n FROM sync_outbox WHERE acknowledged_at IS NULL');assert.equal(Number(pending[0].n),1);
    assert.equal((await flush()).acknowledged,1);assert.equal((await flush()).acknowledged,0);
    const [applied]=await target.query('SELECT COUNT(*) AS n,SUM(amount) AS amount FROM sync_validation_entries');assert.equal(Number(applied[0].n),1);assert.equal(Number(applied[0].amount),10);
    console.log(JSON.stringify({realMysql:true,sourceRollbackVerified:true,lostAcknowledgmentRetried:true,recipientAppliedExactlyOnce:true,sourceAcknowledgmentPersisted:true,productionModified:false}));
  }finally{await Promise.all(pools.map(pool=>pool.end()));}
}
main().catch(()=>{console.error('Isolated MySQL sync drill failed. Inspect validation state.');process.exitCode=1;});
