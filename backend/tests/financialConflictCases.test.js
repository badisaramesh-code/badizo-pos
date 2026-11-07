const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto');
const {createFinancialConflictCases}=require('../services/financialConflictCases');
const identity={shopId:'HFM001',peerInstallationId:'cloud-test',localInstallationId:'local-test'};
const event=()=>({eventId:crypto.randomUUID(),shopId:'HFM001',originInstallationId:'cloud-test',schemaVersion:1,type:'pos.supplier-payment.recorded',payload:{payment:{inward_no:'CLINW/1',amount:'10.00'}}});
test('financial evidence survives retries and restart without discarding or modifying the event',async t=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'financial-cases-'));t.after(()=>fs.rm(directory,{recursive:true,force:true}));
  let store=createFinancialConflictCases({directory,identity});const original=event(),saved=await store.record(original);await store.record(original);assert.equal((await store.list()).length,1);
  const failed=await store.retry(saved.id,{expectedRevision:0,actor:'owner',note:'Checked supplier statement; adjustment still pending'},async received=>{assert.deepEqual(received,original);throw Error('conflict remains');});
  assert.equal(failed.status,'needs-correction');assert.equal(failed.history[0].outcome,'still-blocked');
  store=createFinancialConflictCases({directory,identity});assert.equal((await store.read(saved.id)).revision,1);
  await assert.rejects(store.retry(saved.id,{expectedRevision:0,actor:'owner',note:'Stale retry'},async()=>assert.fail('Must not receive')),/Case changed/);
  const resolved=await store.retry(saved.id,{expectedRevision:1,actor:'owner',note:'Corrected the purchase reference and verified payment'},async received=>{assert.deepEqual(received,original);return {committed:true};});
  assert.equal(resolved.status,'resolved');assert.equal(resolved.history.length,2);assert.equal(resolved.history[1].actor,'owner');
});
test('wrong-shop events cannot create financial evidence',async t=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'financial-cases-'));t.after(()=>fs.rm(directory,{recursive:true,force:true}));
  const store=createFinancialConflictCases({directory,identity});await assert.rejects(store.record({...event(),shopId:'HFM002'}),/identity mismatch/);assert.deepEqual(await store.list(),[]);
});
test('enrolled correction locks are connection owned and a legacy crash lock cannot prevent safe retry',async t=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'financial-cases-db-lock-'));t.after(()=>fs.rm(directory,{recursive:true,force:true}));
  let locked=false,releases=0;
  const pool={getConnection:async()=>({execute:async sql=>{if(sql.startsWith('SELECT GET_LOCK')){assert.equal(locked,false);locked=true;return [[{acquired:1}]];}assert.match(sql,/RELEASE_LOCK/);locked=false;return [[{released:1}]];},release:()=>{releases++;},destroy:()=>{locked=false;}})};
  let store=createFinancialConflictCases({directory,identity,pool});const saved=await store.record(event());
  await fs.writeFile(path.join(directory,identity.shopId,saved.id+'.lock'),'old process crashed');
  const result=await store.retry(saved.id,{expectedRevision:0,actor:'owner',note:'Verified prior operation before retry',action:'match-supplier-payment'},async()=>{throw Error('Commit outcome not confirmed');});
  assert.equal(result.status,'needs-correction');assert.equal(locked,false);
  store=createFinancialConflictCases({directory,identity,pool});
  const resumed=await store.retry(saved.id,{expectedRevision:1,actor:'owner',note:'Retried immutable operation using durable receipts'},async()=>({committed:true,duplicate:true,requiresPeerDelivery:true}));
  assert.equal(resumed.status,'resolved');assert.equal(resumed.history[1].peerDeliveryRequired,true);assert.equal(releases,2);assert.equal(locked,false);
});
test('owner inspection distinguishes a locally committed correction from acknowledged peer delivery',async t=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'financial-cases-peer-'));t.after(()=>fs.rm(directory,{recursive:true,force:true}));
  const store=createFinancialConflictCases({directory,identity}),saved=await store.record(event());
  await store.retry(saved.id,{expectedRevision:0,actor:'owner',note:'Verified original payment evidence'},async()=>({committed:true,requiresPeerDelivery:true}));
  let acknowledged=null;
  const pool={query:async()=>[[]],execute:async sql=>{
    if(sql.startsWith('SELECT supplier_name'))return [[]];
    if(sql.startsWith('SELECT review_json'))return [[{review_json:JSON.stringify({resolutionEventId:'resolution-event'})}]];
    assert.match(sql,/SELECT acknowledged_at/);return [[{acknowledged_at:acknowledged}]];
  }};
  assert.equal((await store.inspect(saved.id,pool)).peerResolution.status,'pending');
  acknowledged='2026-11-02 12:00:00';assert.equal((await store.inspect(saved.id,pool)).peerResolution.status,'delivered');
});
