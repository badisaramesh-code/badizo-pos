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
async function interrupted(t,target,stage,peerAvailable){
  const {config,original,request}=await setup(t);
  config.enrollmentConfigPath=path.join(config.directory,'enrollment.json');
  const enrollment={schemaVersion:1,contractVersion:1,shopId:config.shopId,installationId:'local-qa',peerInstallationId:'cloud-qa',nodeRole:'local-server',databaseName:original.database.database,baselineId:'1'.repeat(64),activationId:original.activationId,settingsDirectory:config.directory,reviewDirectory:config.directory,incomingToken:'2'.repeat(64),peer:{baseUrl:'https://cloud.invalid/api/sync',token:'3'.repeat(64)}};
  await atomic(config.enrollmentConfigPath,enrollment);
  await request('use-'+target);
  const pending=await json(path.join(config.directory,'request.json'));
  await atomic(path.join(config.directory,'operation.json'),{...pending,state:stage});
  await atomic(config.bindingPath,{...original,billingMode:target==='local'&&stage==='activating-local'?'active':'standby',handoffId:pending.id});
  const configPath=path.join(config.directory,'supervisor.json');await atomic(configPath,config);
  const control=require('../services/recoveryControl').createRecoveryControl({configPath,shopId:config.shopId});
  await atomic(path.join(config.directory,'heartbeat.json'),{shopId:config.shopId,at:new Date().toISOString()});
  const mutations=[];
  t.mock.method(global,'fetch',async(url,opts)=>{
    if(opts.method!=='GET'){mutations.push(url);throw Error('Unexpected handoff command');}
    const local=new URL(url).hostname==='127.0.0.1';
    if(!local&&!peerAvailable)throw Error('offline');
    const mode=local?(await json(config.bindingPath)).billingMode:(target==='cloud'?'active':'standby');
    return new Response(JSON.stringify({shopId:config.shopId,installationId:local?'local-qa':'cloud-qa',peerInstallationId:local?'cloud-qa':'local-qa',baselineId:enrollment.baselineId,pending:0,activeWrites:0,phase:'active',billingMode:mode,handoffId:pending.id}));
  });
  return {config,pending,control,mutations};
}
for(const target of ['cloud','local']){
  test('restart resolves lost '+target+' activation acknowledgment by inspecting both nodes',async t=>{
    const {config,mutations}=await interrupted(t,target,'activating-'+target,true);
    await createRecoverySupervisor(config).tick();
    assert.equal((await json(path.join(config.directory,'operation.json'))).state,'complete');
    assert.deepEqual(mutations,[]);
  });
}
test('unreachable peer after attempted activation never activates the alternate',async t=>{
  const {config,mutations}=await interrupted(t,'cloud','activating-cloud',false);
  await createRecoverySupervisor(config).tick();
  const op=await json(path.join(config.directory,'operation.json'));
  assert.equal(op.failureCode,'activation-unconfirmed');assert.deepEqual(op.observedModes,{local:'standby',cloud:'unknown'});assert.deepEqual(mutations,[]);
});
test('restart before activation cannot re-pause a cloud counter that may have resumed emergency sales',async t=>{
  const {config,mutations}=await interrupted(t,'cloud','synchronizing',true);
  await createRecoverySupervisor(config).tick();
  const op=await json(path.join(config.directory,'operation.json'));
  assert.equal(op.state,'failed');assert.equal(op.observedModes.cloud,'active');assert.deepEqual(mutations,[]);
});
test('owner stop survives restart and releases ordinary switch for a separate emergency decision',async t=>{
  const {config,pending,control,mutations}=await interrupted(t,'cloud','synchronizing',false);
  await assert.rejects(control.recoverSwitch({operationId:crypto.randomUUID(),actor:'owner'}));
  await control.recoverSwitch({operationId:pending.id,actor:'owner'});
  assert.equal((await control.status()).operation.stopRequested,true);
  await createRecoverySupervisor(config).tick();
  const status=await control.status();
  assert.equal(status.operation.failureCode,'owner-stopped');assert.equal(status.billingMode,'standby');assert.equal(status.handoffId,null);
  await control.request({kind:'emergency-local',expectedGeneration:status.generation,actor:'owner'});
  assert.deepEqual(mutations,[]);
});
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
test('failed pre-install preparation can resume original local offline and finish cloud cancellation later',async t=>{
  const {config,original}=await setup(t),operationId=crypto.randomUUID();
  config.preparationConfigPath=path.join(config.directory,'preparation-config.json');config.baselinePlanPath=path.join(config.directory,'baseline-plan.json');
  const prepDirectory=path.join(config.directory,'preparation');
  await atomic(config.preparationConfigPath,{schemaVersion:1,shopId:'HFM001',directory:prepDirectory,incomingToken:'a'.repeat(64),baselineIncomingToken:'b'.repeat(64),slots:[{restoreConfigPath:path.join(config.directory,'slot.json')}],peer:{url:'https://cloud.invalid/api/recovery-preparation',token:'c'.repeat(64),baselineToken:'d'.repeat(64)}});
  await atomic(path.join(prepDirectory,'current.json'),{operationId});
  await atomic(path.join(prepDirectory,operationId,'preparation.json'),{operationId,sourceActivationId:original.activationId,mode:'verified-copy',state:'paused'});
  await atomic(config.bindingPath,{...original,phase:'validating',billingMode:'standby',handoffId:operationId});
  const configPath=path.join(config.directory,'supervisor.json');await atomic(configPath,config);
  await atomic(path.join(config.directory,'heartbeat.json'),{shopId:'HFM001',at:new Date().toISOString()});
  const control=require('../services/recoveryControl').createRecoveryControl({configPath,shopId:'HFM001'});
  await atomic(path.join(config.directory,'operation.json'),{id:crypto.randomUUID(),kind:'prepare-baseline',state:'preparing'});
  await assert.rejects(control.request({kind:'emergency-local',expectedGeneration:0,actor:'owner'}));
  await atomic(path.join(config.directory,'operation.json'),{id:crypto.randomUUID(),kind:'prepare-baseline',state:'failed'});
  const savedFetch=global.fetch;t.after(()=>{global.fetch=savedFetch;});
  global.fetch=async()=>{throw Error('Internet offline');};
  const supervisor=createRecoverySupervisor(config,{runCommand:async()=>{throw Error('Original local must not restart or switch databases');},fetchReady:async()=>({ok:true,shopId:'HFM001',recovery:{activationId:original.activationId,activeWrites:0}})});
  await control.request({kind:'emergency-local',expectedGeneration:0,actor:'owner'});await supervisor.tick();
  const active=await json(config.bindingPath);assert.equal(active.activationId,original.activationId);assert.deepEqual(active.database,original.database);assert.equal(active.billingMode,'active');assert.equal(active.handoffId,null);
  const stateFile=path.join(prepDirectory,operationId,'preparation.json');assert.equal((await json(stateFile)).pendingPeerCancel,true);
  global.fetch=async()=>new Response(JSON.stringify({cancelled:true,operationId,cloudStandby:true}),{status:200,headers:{'Content-Type':'application/json'}});
  await control.request({kind:'finish-recovery-cancel',expectedGeneration:active.generation,actor:'owner'});await supervisor.tick();
  assert.deepEqual(await json(config.bindingPath),active);assert.equal((await json(stateFile)).pendingPeerCancel,false);assert.equal((await json(path.join(config.directory,'operation.json'))).state,'complete');
});

test('capture gap refuses owner handoff and supervisor queue before pausing local billing',async t=>{
  const {config,original,request}=await setup(t);
  config.enrollmentConfigPath=path.join(config.directory,'enrollment.json');
  await atomic(config.enrollmentConfigPath,{schemaVersion:1,contractVersion:1,shopId:config.shopId,installationId:'local-qa',peerInstallationId:'cloud-qa',nodeRole:'local-server',databaseName:original.database.database,baselineId:'1'.repeat(64),activationId:original.activationId,settingsDirectory:config.directory,reviewDirectory:config.directory,incomingToken:'2'.repeat(64),peer:{baseUrl:'https://cloud.invalid/api/sync',token:'3'.repeat(64)}});
  await require('../services/captureGap').recordCaptureGap(config.bindingPath,original);
  const configPath=path.join(config.directory,'supervisor.json');await atomic(configPath,config);
  const control=require('../services/recoveryControl').createRecoveryControl({configPath,shopId:config.shopId});
  await atomic(path.join(config.directory,'heartbeat.json'),{shopId:config.shopId,at:new Date().toISOString()});
  assert.equal((await control.status()).handoffAvailable,false);
  await assert.rejects(control.request({kind:'use-cloud',expectedGeneration:original.generation,actor:'owner'}));
  await request('use-cloud');
  await createRecoverySupervisor(config).tick();
  assert.deepEqual(await json(config.bindingPath),original);
  assert.equal((await json(path.join(config.directory,'operation.json'))).state,'failed');
});
