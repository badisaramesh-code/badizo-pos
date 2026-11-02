const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const {executeBillingHandoff}=require('../services/billingHandoff');
function fixture(){
  const id=crypto.randomUUID(),history=[],states=[{billingMode:'active',pending:1},{billingMode:'standby',pending:1}];
  const adapters=states.map((state,index)=>({
    async pause(operation){Object.assign(state,{handoffId:operation,billingMode:'standby',phase:'active',activeWrites:0});history.push('pause'+index);},
    async status(){return {...state};},
    async activate(operation){assert.equal(states[1-index].billingMode,'standby');assert.equal(state.pending,0);assert.equal(state.handoffId,operation);state.billingMode='active';history.push('activate'+index);}
  }));
  return {id,states,history,local:adapters[0],cloud:adapters[1],record:async phase=>history.push(phase),transfer:async()=>{states.forEach(state=>state.pending=0);return {busy:false};}};
}
test('normal handoff drains both directions before activating exactly one node',async()=>{
  for(const target of ['local','cloud']){const f=fixture();assert.equal((await executeBillingHandoff({...f,target})).complete,true);assert.equal(f.states.filter(s=>s.billingMode==='active').length,1);assert.ok(f.history.indexOf('synchronizing')<f.history.indexOf('activate'+(target==='local'?0:1)));}
});
test('failed transfer leaves both nodes paused and does not discard pending data',async()=>{
  const f=fixture();await assert.rejects(executeBillingHandoff({...f,target:'cloud',transfer:async()=>{throw Error('network lost');}}),/network lost/);assert.ok(f.states.every(s=>s.billingMode==='standby'&&s.pending===1));
});
test('lost cloud activation acknowledgement never enables local and retry drains safely',async()=>{
  const f=fixture(),activate=f.cloud.activate;f.cloud.activate=async id=>{await activate(id);throw Error('reply lost');};
  await assert.rejects(executeBillingHandoff({...f,target:'cloud'}),/reply lost/);assert.equal(f.states[0].billingMode,'standby');assert.equal(f.states[1].billingMode,'active');
  f.cloud.activate=activate;await executeBillingHandoff({...f,target:'cloud'});assert.equal(f.states[0].billingMode,'standby');
});
test('emergency override during synchronization prevents normal activation',async()=>{
  const f=fixture();await assert.rejects(executeBillingHandoff({...f,target:'cloud',transfer:async()=>{f.states[0].handoffId='different';return {};}}),/remain paused/);
});
test('finishing sync leases drain before activation; a permanently busy hold stays paused',async()=>{
  const f=fixture(),status=f.local.status;let reads=0;
  f.local.status=async()=>({...await status(),activeWrites:reads++===0?1:0});
  let waits=0;await executeBillingHandoff({...f,target:'cloud',wait:async()=>{waits++;}});assert.equal(waits,1);
  const blocked=fixture();blocked.local.status=async()=>({...blocked.states[0],activeWrites:1});
  await assert.rejects(executeBillingHandoff({...blocked,target:'cloud',maxBusyChecks:2,wait:async()=>{}}),/did not drain/);
  assert.ok(blocked.states.every(state=>state.billingMode==='standby'));
});
