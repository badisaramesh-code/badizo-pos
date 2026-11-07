const fs=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto'),assert=require('node:assert/strict'),{spawn}=require('node:child_process'),mysql=require('mysql2/promise');
const jwt=require('jsonwebtoken');
const {atomic,json}=require('../../backend/services/recoveryControlFiles');
const {createRecoverySupervisor}=require('../../backend/services/recoverySupervisor');
async function main(){
  assert.equal(process.env.DB_NAME,'badizo_cloud_validation');
  const inputs=await Promise.all(process.argv.slice(2).map(json));assert.equal(inputs.length,2);assert.notEqual(inputs[0].database,inputs[1].database);
  for(const input of inputs)assert.match(input.database,/^badizo_recovery_[a-z0-9]+$/);
  const directory=await fs.mkdtemp('/var/lib/badizo/activation-validation-');
  const config={directory,shopId:'HFM001',nodeRole:'local-server',bindingPath:path.join(directory,'binding.json'),restoreConfigPath:path.join(directory,'restore.json'),restoreJobDirectory:directory,readyUrl:'http://127.0.0.1:5002/api/ready',healthTimeoutMs:5000,stop:{kind:'stop'},start:{kind:'start'}};
  const db=value=>({host:value.host,user:value.user,password:value.password,database:value.database});
  const original={schemaVersion:1,shopId:'HFM001',activationId:crypto.randomUUID(),generation:0,phase:'active',billingMode:'active',database:db(inputs[0])};
  const configPath=path.join(directory,'supervisor-config.json');await atomic(configPath,config);
  await atomic(config.bindingPath,original);await atomic(config.restoreConfigPath,{shopId:'HFM001',...db(inputs[1])});
  const target=await mysql.createConnection(db(inputs[1]));
  const [[counts]]=await target.query("SELECT (SELECT COUNT(*) FROM products) AS products,(SELECT COUNT(*) FROM invoices) AS invoices,(SELECT COUNT(*) FROM information_schema.tables WHERE table_schema=DATABASE() AND table_type='BASE TABLE') AS tableCount");await target.end();
  const jobId=crypto.randomUUID();await atomic(path.join(directory,jobId+'.json'),{shopId:'HFM001',state:'verified',result:{database:inputs[1].database,...Object.fromEntries(Object.entries(counts).map(([key,value])=>[key,Number(value)])),activated:false}});
  let child,simulateFailure=false,blockedCandidate=false,testNodeRole='cloud-active';
  async function stop(){if(child&&child.exitCode===null&&child.signalCode===null){const stopped=new Promise(resolve=>child.once('exit',resolve));child.kill('SIGTERM');await stopped;}child=null;}
  async function start(){
    const binding=await json(config.bindingPath);
    if(simulateFailure&&binding.database.database===inputs[1].database)return;
    child=spawn(process.execPath,['server.js'],{cwd:process.cwd(),env:{...process.env,PORT:'5002',HOST:'127.0.0.1',BADIZO_LOOPBACK_ONLY:'true',BADIZO_DISABLE_SCHEDULED_JOBS:'true',BADIZO_SYNC_ENROLLMENT_CONFIG:'',BADIZO_CHECKOUT_REQUEST_GUARD:'false',BADIZO_NODE_ROLE:testNodeRole,BADIZO_RUNTIME_BINDING:config.bindingPath,BADIZO_RECOVERY_CONTROL_CONFIG:configPath,BADIZO_SHOP_ID:'HFM001',BADIZO_DB_BOOTSTRAP:'false',BADIZO_DISABLE_3000_REDIRECT:'true',BADIZO_SMS_ENABLED:'false',BADIZO_WHATSAPP_ENABLED:'false'},stdio:'ignore'});
  }
  async function ready(){const response=await fetch(config.readyUrl,{signal:AbortSignal.timeout(1000)});assert.equal(response.status,200);return response.json();}
  async function awaitReady(){for(let i=0;i<40;i++){try{return await ready();}catch{}await new Promise(resolve=>setTimeout(resolve,250));}throw Error('Isolated POS did not start');}
  async function billingStatus(){return (await fetch('http://127.0.0.1:5002/api/products/save',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})).status;}
  let supervisor=createRecoverySupervisor(config,{runCommand:async command=>command.kind==='stop'?stop():start(),fetchReady:async()=>{
    const value=await ready();const binding=await json(config.bindingPath);
    if(binding.database.database===inputs[1].database&&binding.phase==='validating'){assert.equal(await billingStatus(),409);blockedCandidate=true;}
    return value;
  }});
  async function request(kind){
    await atomic(path.join(directory,'heartbeat.json'),{shopId:'HFM001',at:new Date().toISOString()});
    const phrases={'standby':'PAUSE BILLING','emergency-local':'CLOUD BILLING IS STOPPED - USE LOCAL','activate-restore':'USE VERIFIED RESTORE','emergency-cloud':'LOCAL BILLING IS STOPPED - USE CLOUD'};
    const response=await fetch('http://127.0.0.1:5002/api/recovery-control',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+jwt.sign({role:'SERVER',username:'isolated-owner'},process.env.JWT_SECRET)},body:JSON.stringify({kind,jobId:kind==='activate-restore'?jobId:undefined,expectedGeneration:(await json(config.bindingPath)).generation,confirmation:phrases[kind]})});
    assert.equal(response.status,202);await supervisor.tick();
  }

  try{
    await start();await awaitReady();assert.equal(await billingStatus(),401);
    await request('standby');assert.equal(await billingStatus(),409);
    await request('emergency-local');assert.equal(await billingStatus(),401);assert.equal((await ready()).recovery.reconciliationRequired,true);
    const rebuildFence=await mysql.createConnection(db(inputs[1]));
    try{
      const [[locked]]=await rebuildFence.execute('SELECT GET_LOCK(?,0) AS acquired',['badizo-rebuild:'+inputs[1].database]);assert.equal(Number(locked.acquired),1);
      await request('activate-restore');assert.equal((await json(path.join(directory,'operation.json'))).state,'failed');assert.equal((await ready()).recovery.activationId,original.activationId);
    }finally{await rebuildFence.end();}
    // First candidate deliberately fails startup. The real old POS must return.
    simulateFailure=true;await request('activate-restore');assert.equal((await json(path.join(directory,'operation.json'))).state,'rolled-back');assert.equal((await ready()).recovery.activationId,original.activationId);
    simulateFailure=false;await request('activate-restore');assert.equal((await json(path.join(directory,'operation.json'))).state,'complete');
    const current=await json(config.bindingPath);assert.equal(current.database.database,inputs[1].database);assert.equal((await ready()).recovery.activationId,current.activationId);assert.ok(blockedCandidate);assert.equal(await billingStatus(),401);
    // Process restart must select the activated database again.
    await stop();await start();assert.equal((await awaitReady()).recovery.activationId,current.activationId);
    await request('standby');await stop();testNodeRole='cloud-standby';
    const cloudConfig={...config,nodeRole:'cloud-standby'};await atomic(configPath,cloudConfig);
    supervisor=createRecoverySupervisor(cloudConfig,{runCommand:async command=>command.kind==='stop'?stop():start()});
    await start();await awaitReady();assert.equal(await billingStatus(),409);
    await request('emergency-cloud');assert.equal((await json(path.join(directory,'operation.json'))).state,'complete');assert.equal(await billingStatus(),401);
    console.log(JSON.stringify({rebuildFencePreventsActivation:true,cloudStandbyCanBeActivatedByOwner:true,ownerControlApi:true,realPosRestart:true,realMysqlCandidateVerification:true,standbyBlocksWrites:true,emergencyLocalWorks:true,candidateWritesBlockedUntilHealthy:true,failedStartRestoresOldPos:true,successfulActivationPersistsAcrossRestart:true,oldDatabaseRetained:true,productionModified:false}));
  }finally{await stop();}
}
main().catch(error=>{console.error('Isolated activation drill failed: '+error.message);process.exitCode=1;});
