// Provision TWO empty, isolated databases first. This harness refuses populated
// databases and never connects to a production name or drops a database.
const fs=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto'),assert=require('node:assert/strict'),mysql=require('mysql2/promise');
const {rebuildBaseline}=require('../../backend/services/recoveryBaselineRebuild');
const {validateEvent}=require('../../backend/services/syncEventProtocol');
async function main(){
  const c=JSON.parse(await fs.readFile(process.argv[2],'utf8'));
  assert.ok(path.isAbsolute(c.directory));assert.equal(c.sides.length,2);assert.notEqual(c.sides[0].database,c.sides[1].database);
  for(const side of c.sides){assert.match(side.database,/^badizo_recovery_rebuild[a-z0-9]{2,24}$/);assert.ok(['localhost','127.0.0.1'].includes(side.host));}
  const pools=c.sides.map(side=>mysql.createPool({...side,supportBigNumbers:true,bigNumberStrings:true,connectionLimit:4}));
  try{
    for(const pool of pools){const [[row]]=await pool.query('SELECT COUNT(*) AS n FROM information_schema.tables WHERE table_schema=DATABASE()');assert.equal(Number(row.n),0,'only empty validation databases are allowed');}
    await fs.mkdir(c.directory,{recursive:true,mode:0o700});
    for(const pool of pools){
      for(const migration of ['outbox','inbox','enrollment'])await pool.query(await fs.readFile(path.resolve(__dirname,'../../database/migrations/optional-sync-'+migration+'.sql'),'utf8'));
      await pool.query('CREATE TABLE products (barcode VARCHAR(120) PRIMARY KEY,product_name VARCHAR(255),sale_price DECIMAL(10,2)) ENGINE=InnoDB');
    }
    const ids=['local-'+crypto.randomUUID(),'cloud-'+crypto.randomUUID()],shopId='HFM001',baselineId=crypto.randomBytes(32).toString('hex'),sides=[];
    for(let i=0;i<2;i++){
      const binding=path.join(c.directory,i+'-original-binding.json');await fs.writeFile(binding,JSON.stringify({shopId,database:{database:i?'isolated_original_cloud':'isolated_original_local'}}),{flag:'wx',mode:0o600});
      sides.push({databaseName:c.sides[i].database,installationId:ids[i],peerInstallationId:ids[1-i],originalRuntimeBinding:binding});
      await pools[i].execute('INSERT INTO sync_enrollment (singleton,shop_id,installation_id,peer_installation_id,baseline_id,activation_id,contract_version,enabled) VALUES (1,?,?,?,?,?,1,1)',[shopId,ids[i],ids[1-i],baselineId,crypto.randomUUID()]);
      await pools[i].execute('INSERT INTO products VALUES (?,?,?)',['TEST',i?'new':'old',i?'11.00':'10.00']);
    }
    const own={eventId:crypto.randomUUID(),shopId,originInstallationId:ids[0],schemaVersion:1,type:'pos.product.fields.changed',payload:{barcode:'TEST',changes:[{field:'sale_price',before:'10.00',after:'11.00'}]}};
    const peer={eventId:crypto.randomUUID(),shopId,originInstallationId:ids[1],schemaVersion:1,type:'pos.product.fields.changed',payload:{barcode:'TEST',changes:[{field:'product_name',before:'old',after:'new'}]}};
    for(const event of [own,peer]){
      const verified=validateEvent(event,{shopId,peerInstallationId:event.originInstallationId,localInstallationId:ids.find(id=>id!==event.originInstallationId)});
      await pools[1].execute('INSERT INTO sync_outbox (event_id,shop_id,origin_installation_id,event_json,payload_hash,acknowledged_at) VALUES (?,?,?,?,?,?)',[event.eventId,shopId,event.originInstallationId,verified.serialized,verified.hash,event===own?new Date():null]);
      if(event===own)await pools[1].execute('INSERT INTO sync_inbox (shop_id,event_id,origin_installation_id,payload_hash) VALUES (?,?,?,?)',[shopId,event.eventId,event.originInstallationId,verified.hash]);
    }
    const args={pools,configuration:{shopId,baselineId,sides},reportPath:path.join(c.directory,'rebuild-report.json')};
    const plan=await rebuildBaseline(args);assert.deepEqual(plan.missing,[2,0]);assert.equal(plan.state,'planned');
    const applied=await rebuildBaseline({...args,apply:true});assert.equal(applied.state,'retained-events-reconciled');assert.deepEqual(applied.remaining,[0,0]);assert.equal(applied.readyForEnrollment,false);
    const [[local]]=await pools[0].query('SELECT product_name,sale_price FROM products WHERE barcode="TEST"');assert.equal(local.product_name,'new');assert.equal(local.sale_price,'11.00');
    const again=await rebuildBaseline({...args,apply:true});assert.deepEqual(again.missing,[0,0]);assert.equal(again.applied.length,0);
    const [[pending]]=await pools[1].execute('SELECT COUNT(*) AS n FROM sync_outbox WHERE event_id=? AND acknowledged_at IS NULL',[peer.eventId]);assert.equal(Number(pending.n),1,'original peer queue was not acknowledged/reset');
    const gap={...own,eventId:crypto.randomUUID()},verified=validateEvent(gap,{shopId,peerInstallationId:ids[0],localInstallationId:ids[1]});
    await pools[1].execute('INSERT INTO sync_inbox (shop_id,event_id,origin_installation_id,payload_hash) VALUES (?,?,?,?)',[shopId,gap.eventId,ids[0],verified.hash]);
    const blocked=await rebuildBaseline({...args,apply:true});assert.equal(blocked.state,'blocked');assert.equal(blocked.blockers[0].reason,'receipt-has-no-retained-event');
    console.log(JSON.stringify({lostOwnEventRecovered:true,cloudEventRecovered:true,idempotentResume:true,originalQueuePreserved:true,missingHistoryBlocks:true,enrollmentNotSilentlyEnabled:true,productionModified:false}));
  }finally{await Promise.all(pools.map(pool=>pool.end()));}
}
main().catch(error=>{console.error('Isolated rebuild validation failed: '+error.message);process.exitCode=1;});
