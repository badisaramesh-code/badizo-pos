const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto');
const {atomic,json}=require('../services/recoveryControlFiles');
const {createBaselineActivation,nodeStatus}=require('../services/recoveryBaselineActivation');
async function setup(t,mode='verified-copy'){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'badizo-pair-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const operationId=crypto.randomUUID(),businessHash='a'.repeat(64),configs=[],calls=[],hashes=new Map(),running=[];
  const report={operationId,state:'prepared-disabled',shopId:'HFM001',sourceShopIdentityVerified:true,readyForProtectedEnrollment:true,businessFingerprint:{hash:businessHash},baselineId:'b'.repeat(64),prepared:[true,true],activationIds:[crypto.randomUUID(),crypto.randomUUID()],installationIds:['local-new','cloud-new'],databases:['badizo_recovery_candidate00','badizo_recovery_candidate11']};
  const reportPath=path.join(root,'report.json');await atomic(reportPath,report);
  for(let i=0;i<2;i++){
    const directory=path.join(root,String(i));await fs.mkdir(directory);
    const config={shopId:'HFM001',nodeRole:i?'cloud-standby':'local-server',directory,bindingPath:path.join(directory,'binding.json'),enrollmentConfigPath:path.join(directory,'enrollment.json'),baselinePlanPath:path.join(directory,'plan.json'),stop:{side:i,kind:'stop'},start:{side:i,kind:'start'},baselineTimeoutMs:10};configs.push(config);
    const binding={schemaVersion:1,shopId:'HFM001',activationId:crypto.randomUUID(),generation:0,phase:'active',billingMode:i?'standby':'active',database:{host:'127.0.0.1',user:'fixture',password:'private-secret',database:'original'+i}};running[i]=binding.activationId;
    const enrollment={schemaVersion:1,contractVersion:1,shopId:'HFM001',installationId:i?'cloud-old':'local-old',peerInstallationId:i?'local-old':'cloud-old',nodeRole:config.nodeRole,databaseName:binding.database.database,activationId:binding.activationId,baselineId:'c'.repeat(64),settingsDirectory:directory,reviewDirectory:directory,incomingToken:String(i).repeat(64),peer:i?null:{baseUrl:'https://cloud.invalid/api/sync',token:'1'.repeat(64)}};
    await atomic(config.bindingPath,binding);await atomic(config.enrollmentConfigPath,enrollment);
    await atomic(config.baselinePlanPath,{schemaVersion:1,shopId:'HFM001',side:i,mode,operationId,reportPath,incomingToken:String(i+2).repeat(64),sourceActivationId:binding.activationId,database:{...binding.database,database:report.databases[i]},peer:i?null:{url:'https://cloud.invalid/api/recovery-baseline',token:'3'.repeat(64)}});
    hashes.set(binding.database.database,businessHash);hashes.set(report.databases[i],businessHash);
  }
  let failStart=-1,failRelease=false,cloudReady=true;
  const adapters=i=>({
    inspect:async database=>{if(database.database.startsWith('original'))assert.equal((await json(configs[i].bindingPath)).phase,'validating','source must stay frozen during its checkpoint');return {hash:hashes.get(database.database)};},
    enable:async()=>{},acquireDatabaseFence:async()=>async()=>{},
    runCommand:async command=>{calls.push(command);if(command.kind==='start'){if(failStart===i){failStart=-1;throw Error('Injected startup failure');}running[i]=(await json(configs[i].bindingPath)).activationId;}},
    waitReady:async activationId=>{assert.equal(running[i],activationId);const binding=await json(configs[i].bindingPath),enrollment=await json(configs[i].enrollmentConfigPath);return {sync:{ready:binding.phase==='active',shopId:'HFM001',baselineId:enrollment.baselineId,installationId:enrollment.installationId,peerInstallationId:enrollment.peerInstallationId}};}
  });
  let cloud=createBaselineActivation(configs[1],adapters(1));
  const local=createBaselineActivation(configs[0],{...adapters(0),verifySyncPeer:async enrollment=>assert.equal(enrollment.baselineId,(await json(configs[1].enrollmentConfigPath)).baselineId),callPeer:async action=>{
    if(action==='stage')await cloud.stage(operationId);
    if(action==='release'){await cloud.release(operationId);if(failRelease){failRelease=false;throw Error('Lost release acknowledgement');}}
    return {...await cloud.status(),runtimeReady:cloudReady,activeWrites:0};
  }});
  return {configs,report,local,calls,hashes,setFailStart:i=>{failStart=i;},setStopped:i=>{running[i]=null;},setFailRelease:()=>{failRelease=true;},setCloudReady:value=>{cloudReady=value;},restartCloud:()=>{cloud=createBaselineActivation(configs[1],adapters(1));},cloud:()=>cloud};
}
test('prepared two-host recovery verifies sources frozen, changes both baselines and enables local only',async t=>{
  const fixture=await setup(t);const result=await fixture.local.reconnect();assert.equal(result.complete,true);
  const states=await Promise.all(fixture.configs.map(nodeStatus));assert.equal(states[0].billingMode,'active');assert.equal(states[1].billingMode,'standby');assert.ok(states.every(s=>s.installed&&!s.held));
  assert.equal(states[0].state,'complete');assert.equal(states[1].state,'released');assert.equal(fixture.calls.length,4);
  assert.ok(!JSON.stringify(states).includes('private-secret'));
});
test('new source data blocks copy without activating either prepared database',async t=>{
  const fixture=await setup(t);fixture.hashes.set('original1','d'.repeat(64));
  await assert.rejects(fixture.local.reconnect(),/Source changed/);
  assert.ok((await Promise.all(fixture.configs.map(nodeStatus))).every(s=>!s.installed&&s.billingMode==='standby'&&s.phase==='validating'));
});
test('lost-local copy requires explicit acknowledgement and still checks final cloud data',async t=>{
  const fixture=await setup(t,'lost-local-copy');fixture.hashes.set('original0','d'.repeat(64));
  await assert.rejects(fixture.local.reconnect(),/acknowledgement/);assert.equal((await nodeStatus(fixture.configs[0])).billingMode,'active');
  const result=await fixture.local.reconnect({acknowledgeLostLocal:true});assert.equal(result.dataLossAcknowledged,true);
  assert.equal((await nodeStatus(fixture.configs[0])).dataLossAcknowledged,true);
});
test('interrupted candidate startup resumes same journal without reusing original enrollment',async t=>{
  const fixture=await setup(t);fixture.setFailStart(1);
  await assert.rejects(fixture.local.reconnect(),/startup failure/);fixture.restartCloud();
  await fixture.local.reconnect();assert.equal((await nodeStatus(fixture.configs[0])).state,'complete');
  const journal=await json(path.join(fixture.configs[1].directory,'baseline-node.json'));assert.equal(journal.originalEnrollment.installationId,'cloud-old');
});
test('lost final acknowledgement never rolls back newly active local bills on retry',async t=>{
  const fixture=await setup(t);fixture.setFailRelease();await assert.rejects(fixture.local.reconnect(),/Lost release/);
  assert.equal((await nodeStatus(fixture.configs[0])).billingMode,'active');
  fixture.hashes.set(fixture.report.databases[0],'e'.repeat(64));const commands=fixture.calls.length;
  await fixture.local.reconnect();assert.equal(fixture.calls.length,commands);assert.equal((await nodeStatus(fixture.configs[0])).state,'complete');
});
test('restart between enrollment-file and binding writes resumes without a running original process',async t=>{
  const fixture=await setup(t);fixture.setFailStart(1);await assert.rejects(fixture.local.reconnect(),/startup failure/);
  const journal=await json(path.join(fixture.configs[1].directory,'baseline-node.json'));
  // Model the earlier crash window: new enrollment already durable, pointer
  // still the frozen old source, and no process is running to answer readiness.
  await atomic(fixture.configs[1].bindingPath,journal.originalBinding);fixture.setStopped(1);fixture.restartCloud();
  await fixture.local.reconnect();assert.equal((await nodeStatus(fixture.configs[0])).state,'complete');
  assert.equal((await json(path.join(fixture.configs[1].directory,'baseline-node.json'))).originalEnrollment.installationId,'cloud-old');
});
test('binding pointer alone cannot establish healthy cloud enrollment',async t=>{
  const fixture=await setup(t);fixture.setCloudReady(false);
  await assert.rejects(fixture.local.reconnect(),/did not confirm/);assert.equal((await nodeStatus(fixture.configs[0])).billingMode,'standby');
});
test('recovery peer authenticates before parsing and accepts only its prepared operation',async t=>{
  const fixture=await setup(t),express=require('express'),calls=[];
  const configPath=path.join(fixture.configs[1].directory,'config.json');await atomic(configPath,fixture.configs[1]);
  const app=express();app.use('/peer',require('../routes/recoveryBaseline').createRouter({configPath,control:{status:async()=>({generation:0}),request:async value=>{calls.push(value);return {state:'queued'};}}}));
  const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
  const url='http://127.0.0.1:'+server.address().port+'/peer';
  const send=(body,token)=>fetch(url,{method:'POST',headers:{'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{})},body});
  assert.equal((await send('{malformed')).status,401);
  assert.equal((await send(JSON.stringify({action:'stage',operationId:crypto.randomUUID()}),'3'.repeat(64))).status,409);
  assert.equal((await send(JSON.stringify({action:'stage',operationId:fixture.report.operationId,database:'forged'}),'3'.repeat(64))).status,409);
  assert.equal((await send(JSON.stringify({action:'stage',operationId:fixture.report.operationId}),'3'.repeat(64))).status,202);
  assert.equal(calls.length,1);assert.equal(calls[0].handoffId,fixture.report.operationId);
  assert.equal(calls[0].kind,'baseline-stage');assert.equal(calls[0].actor,'prepared-recovery-peer');
});
