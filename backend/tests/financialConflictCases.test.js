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
