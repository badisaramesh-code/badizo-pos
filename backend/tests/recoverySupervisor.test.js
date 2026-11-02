const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const {atomic,json}=require('../services/recoveryControlFiles');
const {createRecoverySupervisor:realSupervisor}=require('../services/recoverySupervisor');
const createRecoverySupervisor=(config,options={})=>realSupervisor(config,{acquireDatabaseFence:async()=>async()=>{},...options});
async function setup(t){
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'badizo-supervisor-'));t.after(()=>fs.rm(directory,{recursive:true,force:true}));
  const config={shopId:'HFM001',nodeRole:'local-server',directory,bindingPath:path.join(directory,'binding.json'),restoreConfigPath:path.join(directory,'restore.json'),restoreJobDirectory:directory,readyUrl:'http://127.0.0.1:5009/api/ready',healthTimeoutMs:260,stop:{kind:'stop'},start:{kind:'start'}};
  const original={schemaVersion:1,shopId:config.shopId,activationId:crypto.randomUUID(),generation:0,phase:'active',billingMode:'active',database:{host:'127.0.0.1',user:'test',password:'secret',database:'original'}};
  await atomic(config.bindingPath,original);
  const jobId=crypto.randomUUID();await atomic(config.restoreConfigPath,{shopId:config.shopId,...original.database,database:'badizo_recovery_test12345'});
  await atomic(path.join(directory,jobId+'.json'),{shopId:config.shopId,state:'verified',result:{database:'badizo_recovery_test12345',products:1,invoices:1,tableCount:50,activated:false}});
  async function request(kind='activate-restore'){await atomic(path.join(directory,'request.json'),{id:crypto.randomUUID(),shopId:config.shopId,kind,jobId,expectedGeneration:(await json(config.bindingPath)).generation,actor:'owner'});}
  return {config,original,request};
}
test('activation stays blocked until matching process is healthy and retains previous credentials privately',async t=>{
  const {config,original,request}=await setup(t);let running=original.activationId;const calls=[];
  const supervisor=createRecoverySupervisor(config,{verify:async()=>{},runCommand:async command=>{calls.push(command.kind);if(command.kind==='start'){const state=await json(config.bindingPath);assert.equal(state.phase,'validating');running=state.activationId;}},fetchReady:async()=>({ok:true,shopId:'HFM001',recovery:{activationId:running,activeWrites:0}})});
  await request();await supervisor.tick();const current=await json(config.bindingPath);
  assert.equal(current.phase,'active');assert.equal(current.database.database,'badizo_recovery_test12345');assert.deepEqual(calls,['stop','start']);
  assert.deepEqual(await json(path.join(config.directory,'rollback-binding.json')),original);
  const operation=await json(path.join(config.directory,'operation.json'));assert.equal(operation.state,'complete');assert.ok(!JSON.stringify(operation).includes('secret'));
});
test('failed candidate startup restores old binding and does not delete either database',async t=>{
  const {config,original,request}=await setup(t);let running=original.activationId;
  const supervisor=createRecoverySupervisor(config,{verify:async()=>{},runCommand:async command=>{if(command.kind==='start')running=(await json(config.bindingPath)).activationId;},fetchReady:async()=>{if(running!==original.activationId)throw Error('Candidate failed');return {ok:true,shopId:'HFM001',recovery:{activationId:running,activeWrites:0}};}});
  await request();await supervisor.tick();assert.deepEqual(await json(config.bindingPath),original);assert.equal((await json(path.join(config.directory,'operation.json'))).state,'rolled-back');
});
test('in-flight writes prevent restart and restore prior mode on timeout',async t=>{
  const {config,original,request}=await setup(t);
  const supervisor=createRecoverySupervisor(config,{verify:async()=>{},runCommand:async()=>{throw Error('Must not stop an active request');},fetchReady:async()=>({ok:true,shopId:'HFM001',recovery:{activationId:original.activationId,activeWrites:1}})});
  await request();await supervisor.tick();assert.deepEqual(await json(config.bindingPath),original);assert.equal((await json(path.join(config.directory,'operation.json'))).state,'rolled-back');
});
test('pause and emergency-local persist across supervisor reconstruction',async t=>{
  const {config,original,request}=await setup(t);const adapters={verify:async()=>{},runCommand:async()=>{throw Error('Mode changes must not restart');},fetchReady:async()=>({ok:true,shopId:'HFM001',recovery:{activationId:original.activationId,activeWrites:0}})};
  await request('standby');await createRecoverySupervisor(config,adapters).tick();assert.equal((await json(config.bindingPath)).billingMode,'standby');
  await request('emergency-local');await createRecoverySupervisor(config,adapters).tick();const current=await json(config.bindingPath);assert.equal(current.billingMode,'active');assert.equal(current.reconciliationRequired,true);assert.equal(current.generation,2);
});
test('restart after activation commit never rolls back a database that may contain new sales',async t=>{
  const {config,original,request}=await setup(t);await request();
  const pending=await json(path.join(config.directory,'request.json'));
  const activated={...original,activationId:crypto.randomUUID(),generation:1,database:{...original.database,database:'badizo_recovery_test12345'}};
  await atomic(path.join(config.directory,'rollback-binding.json'),original);
  await atomic(config.bindingPath,activated);
  await atomic(path.join(config.directory,'operation.json'),{id:pending.id,state:'committing',targetId:activated.activationId});
  await createRecoverySupervisor(config,{runCommand:async()=>{throw Error('Must not restart or roll back');}}).tick();
  assert.deepEqual(await json(config.bindingPath),activated);assert.equal((await json(path.join(config.directory,'operation.json'))).state,'complete');
});
test('reconstruction fence blocks restore activation before pausing the original server',async t=>{
  const {config,original,request}=await setup(t);await request();
  const supervisor=createRecoverySupervisor(config,{acquireDatabaseFence:async()=>{throw Error('Candidate is being rebuilt');},verify:async()=>{throw Error('Must not inspect an unfenced candidate');},runCommand:async()=>{throw Error('Must not stop billing');}});
  await supervisor.tick();assert.deepEqual(await json(config.bindingPath),original);
  assert.equal((await json(path.join(config.directory,'operation.json'))).state,'failed');
});
