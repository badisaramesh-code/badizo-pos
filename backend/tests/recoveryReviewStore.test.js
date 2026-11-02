const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createRecoveryReviewStore } = require('../services/recoveryReviewStore');
const input = {shopId:'HFM001',baselineId:'seed',localCheckpoint:'l1',cloudCheckpoint:'c1',fields:[
  {kind:'product',recordId:'p1',field:'selling_price',base:10,local:11,cloud:12},
  {kind:'product',recordId:'p2',field:'name',base:'old',local:'local',cloud:'cloud'},
  {kind:'financial',recordId:'payment1',field:'amount',base:10,local:11,cloud:12}
]};
async function setup(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(),'badizo-review-'));
  t.after(()=>fs.rm(directory,{recursive:true,force:true}));
  return {directory,shopId:'HFM001'};
}
test('decisions survive restart, accumulate across batches and retain corrections',async t=>{
  const options=await setup(t), store=createRecoveryReviewStore(options);
  const initial=await store.create(input),id=initial.plan.id;
  await store.select(id,{expectedRevision:0,side:'local',actor:'owner',conflictIds:[initial.plan.entries[0].id]});
  const restarted=createRecoveryReviewStore(options);
  let state=await restarted.select(id,{expectedRevision:1,side:'cloud',actor:'owner',conflictIds:[initial.plan.entries[1].id]});
  assert.equal(state.decisions.length,2);assert.equal(state.unresolvedConflictIds.length,1);
  state=await restarted.select(id,{expectedRevision:2,side:'cloud',actor:'owner',conflictIds:[initial.plan.entries[0].id]});
  assert.equal(state.history.length,3);assert.equal(state.decisions[0].chosenValue,12);
  assert.equal(state.history[0].decisions[0].chosenValue,11);
  assert.equal(state.safeToResumeLocal,false);
});
test('concurrent owner submissions have one winner and stale retries are rejected',async t=>{
  const options=await setup(t), a=createRecoveryReviewStore(options),b=createRecoveryReviewStore(options);
  const {plan}=await a.create(input);
  const choice={expectedRevision:0,actor:'owner',conflictIds:[plan.entries[0].id]};
  const results=await Promise.allSettled([a.select(plan.id,{...choice,side:'local'}),b.select(plan.id,{...choice,side:'cloud'})]);
  assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
  assert.equal((await a.read(plan.id)).revision,1);
  await assert.rejects(a.select(plan.id,{...choice,side:'local'}));
});
test('cross-shop access, invalid paths and corrupted records are rejected',async t=>{
  const options=await setup(t), store=createRecoveryReviewStore(options);
  await assert.rejects(store.create({...input,shopId:'HFM002'}));
  await assert.rejects(store.read('../other'));
  const {plan}=await store.create(input);
  const filename=path.join(options.directory,'HFM001',plan.id,'0.json');
  const record=JSON.parse(await fs.readFile(filename,'utf8'));record.plan.entries[0].local=999;
  await fs.writeFile(filename,JSON.stringify(record));
  await assert.rejects(store.read(plan.id),/Invalid recovery history/);
});
