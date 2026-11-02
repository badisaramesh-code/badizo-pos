const test = require('node:test');
const assert = require('node:assert/strict');
const { compareField, createPlan, resolveProductConflicts } = require('../services/recoveryMergePolicy');
const field = { kind:'product',recordId:'stable-product-uuid',field:'selling_price',base:100,local:110,cloud:120 };
const input = {shopId:'HFM001',baselineId:'seed-1',localCheckpoint:'local-10',cloudCheckpoint:'cloud-20',fields:[field]};
test('three-way comparison preserves changes made on either side and identifies true conflicts',()=>{
  assert.deepEqual(compareField({base:100,local:110,cloud:100}),{state:'local-only',value:110});
  assert.deepEqual(compareField({base:100,local:100,cloud:120}),{state:'cloud-only',value:120});
  assert.deepEqual(compareField({base:100,local:110,cloud:110}),{state:'equal',value:110});
  assert.deepEqual(compareField(field),{state:'conflict'});
  assert.throws(()=>compareField({local:110,cloud:120}));
});
test('bulk choice records both originals without mutating the source plan or activating local',()=>{
  const plan=createPlan(input),original=JSON.stringify(plan);
  const result=resolveProductConflicts(plan,{expectedPlanId:plan.id,side:'cloud',actor:'owner',conflictIds:[plan.entries[0].id]});
  assert.equal(result.decisions[0].chosenValue,120);
  assert.equal(result.decisions[0].local,110);
  assert.equal(result.safeToResumeLocal,false);
  assert.equal(result.applied,false);
  assert.equal(JSON.stringify(plan),original);
});
test('stock and financial conflicts cannot be bulk accepted',()=>{
  for (const modified of [{kind:'stock',field:'quantity'},{kind:'financial',field:'amount'},{kind:'product',field:'stock_qty'}]) {
    const plan=createPlan({...input,fields:[{...field,...modified}]});
    assert.throws(()=>resolveProductConflicts(plan,{expectedPlanId:plan.id,side:'local',actor:'owner',conflictIds:[plan.entries[0].id]}));
  }
});
test('stale or altered previews, duplicate records and unknown conflicts fail closed',()=>{
  const plan=createPlan(input);
  const decision={expectedPlanId:plan.id,side:'local',actor:'owner',conflictIds:[plan.entries[0].id]};
  assert.throws(()=>resolveProductConflicts(plan,{...decision,expectedPlanId:'stale'}));
  assert.throws(()=>resolveProductConflicts(plan,{...decision,conflictIds:['missing']}));
  plan.entries[0].local=999;
  assert.throws(()=>resolveProductConflicts(plan,decision));
  assert.throws(()=>createPlan({...input,fields:[field,field]}));
});
