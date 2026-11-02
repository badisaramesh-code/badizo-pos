const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const {prepareSameSnapshotEnrollment,verifiedArtifact,eligiblePartial}=require('../services/recoveryBaselineEnrollment');
const sync=['sync_invoice_batch_map','sync_invoice_item_map','sync_invoice_map','sync_stock_adjustment_map','sync_supplier_payment_map','sync_recovery_applications','sync_worker_state','sync_inbox','sync_outbox','sync_enrollment'];
async function fixture(t){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'badizo-copy-baseline-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const configuration={shopId:'HFM001',confirmation:'COPY VERIFIED SNAPSHOT; PRESERVE ORIGINAL DATABASES',sides:[]},sql='-- isolated verified snapshot\n',sqlSha256=crypto.createHash('sha256').update(sql).digest('hex');
  const states=[];let failSecond=false;
  for(let i=0;i<2;i++){
    const databaseName='badizo_recovery_copy000'+i,artifactDirectory=path.join(root,'artifact'+i),originalRuntimeBinding=path.join(root,i+'-binding.json');await fs.mkdir(artifactDirectory);
    await fs.writeFile(path.join(artifactDirectory,'database.sql'),sql);await fs.writeFile(path.join(artifactDirectory,'manifest.json'),JSON.stringify({shopId:'HFM001',integrityVerified:true,sqlSha256,sqlBytes:Buffer.byteLength(sql)}));
    await fs.writeFile(path.join(artifactDirectory,'restore-result.json'),JSON.stringify({shopId:'HFM001',database:databaseName,stagedRestoreVerified:true,activated:false,sqlSha256}));
    await fs.writeFile(originalRuntimeBinding,JSON.stringify({shopId:'HFM001',database:{database:'original'+i}}));configuration.sides.push({databaseName,artifactDirectory,originalRuntimeBinding});
    states.push({products:[{id:1,barcode:'P',stock_qty:'5.00'}],invoices:[],sync_checkout_requests:[{request_id:'retained-request',intent_hash:'immutable-intent',invoice_no:'OLD/1'}],...Object.fromEntries(sync.map(name=>[name,name==='sync_outbox'?[{event_json:'preserved original evidence'}]:[]]))});
    states[i].sync_enrollment=[{shop_id:'HFM001',installation_id:'source-cloud',peer_installation_id:'source-local',baseline_id:'c'.repeat(64),activation_id:'77d0a4e9-3cf9-4fc3-9356-bb1c11470bd8',contract_version:1,enabled:1}];
  }
  const pools=states.map((state,index)=>({getConnection:async()=>{let before;return {
    query:async(sql)=>{
      const text=typeof sql==='string'?sql:sql.sql;
      if(text.startsWith('SELECT DATABASE'))return [[{name:configuration.sides[index].databaseName,version:'8.0.46'}]];
      if(text.includes('information_schema.tables'))return [Object.keys(state).map(name=>({name,engine:'InnoDB',type:'BASE TABLE'}))];
      if(text.includes('information_schema.routines')||text.includes('information_schema.events'))return [[{n:0}]];
      if(text.includes('information_schema.triggers'))return [[]];
      if(text.startsWith('SHOW CREATE TABLE')){const name=/`([^`]+)`/.exec(text)[1];return [[{Table:name,'Create Table':'CREATE TABLE `'+name+'` (id int) ENGINE=InnoDB'}]];}
      if(text.startsWith('SHOW KEYS'))return [[]];
      if(text.startsWith('SELECT invoice_no FROM invoices'))return [[]];
      const name=/`([^`]+)`/.exec(text)?.[1];
      if(text.startsWith('SELECT *'))return [structuredClone(state[name])];
      if(text.startsWith('DELETE FROM')){state[name]=[];return [{}];}
      throw Error('Unexpected query '+text);
    },execute:async(sql,args)=>{
      if(sql.includes('GET_LOCK'))return [[{acquired:1}]];if(sql.includes('RELEASE_LOCK'))return [[{}]];
      if(sql.startsWith('INSERT INTO sync_enrollment')){state.sync_enrollment=[{shop_id:args[0],installation_id:args[1],peer_installation_id:args[2],baseline_id:args[3],activation_id:args[4],contract_version:1,enabled:0}];return [{}];}
      if(sql.startsWith('SELECT * FROM sync_enrollment'))return [structuredClone(state.sync_enrollment)];throw Error('Unexpected execute '+sql);
    },beginTransaction:async()=>{before=structuredClone(state);},commit:async()=>{if(index===1&&failSecond){failSecond=false;throw Error('Interrupted second candidate');}before=null;},rollback:async()=>{if(before){for(const key of Object.keys(state))delete state[key];Object.assign(state,before);before=null;}},release(){}
  };}}));
  return {configuration,pools,states,reportPath:path.join(root,'copy-report.json'),failSecond:()=>{failSecond=true;}};
}
test('same-snapshot candidates retain old sync evidence and prepare fresh disabled identities without changing business rows',async t=>{
  const f=await fixture(t),before=f.states.map(s=>structuredClone(s.products));const report=await prepareSameSnapshotEnrollment(f);
  assert.equal(report.state,'prepared-disabled');assert.equal(report.activated,false);assert.equal(report.syncEnabled,false);assert.equal(report.readyForProtectedEnrollment,true);assert.notEqual(report.installationIds[0],report.installationIds[1]);
  for(let i=0;i<2;i++){assert.deepEqual(f.states[i].products,before[i]);assert.equal(f.states[i].sync_checkout_requests[0].request_id,'retained-request');assert.equal(f.states[i].sync_outbox.length,0);assert.equal(f.states[i].sync_enrollment[0].enabled,0);assert.match(await fs.readFile(report.archives[i].file,'utf8'),/preserved original evidence/);}
  const again=await prepareSameSnapshotEnrollment(f);assert.deepEqual(again.installationIds,report.installationIds);
});
test('interrupted second-candidate preparation resumes without enabling either candidate or losing archives',async t=>{
  const f=await fixture(t);f.failSecond();await assert.rejects(prepareSameSnapshotEnrollment(f),/Interrupted/);
  const report=JSON.parse(await fs.readFile(f.reportPath,'utf8'));assert.deepEqual(report.prepared,[true,false]);assert.equal(f.states[0].sync_enrollment[0].enabled,0);assert.equal(f.states[1].sync_outbox.length,1);
  const resumed=await prepareSameSnapshotEnrollment(f);assert.equal(resumed.state,'prepared-disabled');assert.deepEqual(resumed.prepared,[true,true]);
});
test('divergent business stock and changed SQL artifact refuse candidate reset',async t=>{
  const f=await fixture(t);f.states[1].products[0].stock_qty='6.00';await assert.rejects(prepareSameSnapshotEnrollment(f),/diverge/);assert.equal(f.states[0].sync_outbox.length,1);
  await fs.appendFile(path.join(f.configuration.sides[0].artifactDirectory,'database.sql'),'tampered');await assert.rejects(verifiedArtifact(f.configuration.sides[0].artifactDirectory,'HFM001',f.configuration.sides[0].databaseName),/SQL changed/);
});
test('partial invoice baseline retains the current returned amount and excludes unsupported profiles',()=>{
  const partial={invoice:{invoice_status:'PARTIALLY_RETURNED',exchange_total:'0.00',exchange_items_json:null,loyalty_redeemed_points:0,loyalty_redeemed_amount:0},items:[{quantity:'3.00',returned_qty:'1.00',is_free_bonus:0,free_offer_id:null}],loyaltyTransactions:[]};
  assert.equal(eligiblePartial(partial),true);assert.equal(partial.items[0].returned_qty,'1.00');assert.equal(eligiblePartial({...partial,loyaltyTransactions:[{id:1}]}),false);
});
test('relabeled wrong-shop and unenrolled legacy snapshots cannot become enrollment-ready',async t=>{
  const wrong=await fixture(t);wrong.states[1].sync_enrollment[0].shop_id='HFM002';
  await assert.rejects(prepareSameSnapshotEnrollment(wrong),/source shop enrollment/);assert.equal(wrong.states[0].sync_outbox.length,1);assert.equal(wrong.states[1].sync_enrollment[0].shop_id,'HFM002');
  const unknown=await fixture(t);unknown.states.forEach(state=>{state.sync_enrollment=[];});
  await assert.rejects(prepareSameSnapshotEnrollment(unknown),/source shop enrollment/);assert.equal(unknown.states[0].sync_outbox.length,1);
});
