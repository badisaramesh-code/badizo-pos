const fs=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto');
const {spawn}=require('node:child_process');
const mysql=require('mysql2/promise');
const {atomic,json}=require('./recoveryControlFiles');
const {validate}=require('./recoveryRuntimeBinding');
const {executeBillingHandoff}=require('./billingHandoff');
const terminal=new Set(['complete','rolled-back','failed']);
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
function command(value){
  if(!value||!path.isAbsolute(value.file||'')||!Array.isArray(value.args)||value.args.some(arg=>typeof arg!=='string'))throw Error('Fixed service commands are required.');
  return new Promise((resolve,reject)=>{
    const child=spawn(value.file,value.args,{shell:false,windowsHide:true,stdio:'ignore'});
    const timer=setTimeout(()=>{child.kill();reject(Error('Service command timed out.'));},60000);
    child.once('error',()=>{clearTimeout(timer);reject(Error('Service command failed.'));});
    child.once('exit',code=>{clearTimeout(timer);code===0?resolve():reject(Error('Service command failed.'));});
  });
}
async function verifyDatabase(binding,expected){
  const connection=await mysql.createConnection({...binding.database,connectTimeout:10000});
  try{
    const [[version]]=await connection.query('SELECT VERSION() AS version');
    if(!/^8\.0\./.test(version.version))throw Error('Recovery requires the verified MySQL 8.0 runtime.');
    const [[counts]]=await connection.query('SELECT (SELECT COUNT(*) FROM products) AS products,(SELECT COUNT(*) FROM invoices) AS invoices,(SELECT COUNT(*) FROM information_schema.tables WHERE table_schema=DATABASE() AND table_type=\'BASE TABLE\') AS tableCount');
    if(['products','invoices','tableCount'].some(key=>Number(counts[key])!==expected[key]))throw Error('Recovery database changed after verification.');
    const [tables]=await connection.query("SELECT table_name,engine FROM information_schema.tables WHERE table_schema=DATABASE() AND table_name IN ('products','invoices','invoice_items','users','app_settings')");
    if(tables.length!==5||tables.some(row=>row.ENGINE!=='InnoDB'&&row.engine!=='InnoDB'))throw Error('Recovery schema is not ready.');
  }finally{await connection.end();}
}
function createRecoverySupervisor(config,{runCommand=command,verify=verifyDatabase,fetchReady}={}){
  if(!config||!path.isAbsolute(config.directory||'')||!path.isAbsolute(config.bindingPath||'')||!path.isAbsolute(config.restoreConfigPath||'')||!path.isAbsolute(config.restoreJobDirectory||''))throw Error('Absolute supervisor paths required.');
  if(!/^[A-Z][A-Z0-9_-]{2,31}$/.test(config.shopId||'')||!['local-server','cloud-standby','cloud-active'].includes(config.nodeRole))throw Error('Explicit shop and node role required.');
  const url=new URL(config.readyUrl);
  if(url.protocol!=='http:'||!['127.0.0.1','localhost','[::1]'].includes(url.hostname)||url.pathname!=='/api/ready'||url.username||url.password||url.search||url.hash)throw Error('Readiness must use the local POS endpoint.');
  const operationPath=path.join(config.directory,'operation.json'),requestPath=path.join(config.directory,'request.json'),rollbackPath=path.join(config.directory,'rollback-binding.json');
  const getReady=fetchReady|| (async()=>{const response=await fetch(url,{signal:AbortSignal.timeout(2000),redirect:'error'});if(!response.ok)throw Error('POS is not ready.');return response.json();});
  async function waitReady(activationId,{drained=false}={}){
    const end=Date.now()+(config.healthTimeoutMs||30000);
    while(Date.now()<end){
      try{const result=await getReady();if(result.ok===true&&result.shopId===config.shopId&&result.recovery?.activationId===activationId&&(!drained||result.recovery.activeWrites===0))return result;}catch{}
      await sleep(250);
    }
    throw Error('POS readiness or write drain timed out.');
  }
  async function binding(){return validate(await json(config.bindingPath),config.shopId);}
  async function record(value){await atomic(operationPath,{...value,updatedAt:new Date().toISOString()});}
  async function coordinated(request,existing){
    const op=existing?.id===request.id?existing:{id:request.id,kind:request.kind,actor:request.actor,shopId:config.shopId,state:'preparing',startedAt:new Date().toISOString()};
    if(terminal.has(op.state)){
      const current=await binding();if(current.handoffId===request.id)await atomic(config.bindingPath,{...current,handoffId:null});
      await fs.unlink(requestPath);return;
    }
    try{
      if(config.nodeRole!=='local-server'||!path.isAbsolute(config.enrollmentConfigPath||''))throw Error('Local enrolled supervisor required.');
      const enrollment=require('./enrolledSyncRuntime').validateConfiguration(await json(config.enrollmentConfigPath),{BADIZO_SHOP_ID:config.shopId,BADIZO_NODE_ROLE:config.nodeRole});
      const current=await binding();
      if(current.activationId!==enrollment.activationId||current.database.database!==enrollment.databaseName)throw Error('Recovery baseline must be rebuilt first.');
      if(!existing&&current.generation!==request.expectedGeneration)throw Error('Runtime changed.');
      await record(op);
      function client(base,token){
        return async(suffix='',body)=>{
          const response=await fetch(base+suffix,{method:body===undefined?'GET':'POST',redirect:'error',signal:AbortSignal.timeout(20000),headers:{Authorization:'Bearer '+token,'X-Badizo-Baseline':enrollment.baselineId,'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});
          if(!response.ok){await response.body?.cancel();throw Error('Handoff endpoint unavailable.');}
          const text=await response.text();if(text.length>65536)throw Error('Invalid handoff response.');return JSON.parse(text);
        };
      }
      const localCall=client(new URL('/api/sync/handoff',url).href,enrollment.incomingToken);
      const cloudCall=client(enrollment.peer.baseUrl.replace(/\/$/,'')+'/handoff',enrollment.peer.token);
      async function checkedStatus(call,local){
        const state=await call();
        if(state.shopId!==enrollment.shopId||state.baselineId!==enrollment.baselineId||state.installationId!==(local?enrollment.installationId:enrollment.peerInstallationId)||state.peerInstallationId!==(local?enrollment.peerInstallationId:enrollment.installationId)||!Number.isSafeInteger(state.pending)||state.pending<0||!Number.isSafeInteger(state.activeWrites)||state.activeWrites<0)throw Error('Handoff peer identity or counters differ.');
        return state;
      }
      async function remoteMode(id,action){
        let state=await checkedStatus(cloudCall,false);
        const mode=action==='pause'?'standby':'active';
        if(state.handoffId===id&&state.billingMode===mode&&state.phase==='active'&&state.operation?.state==='complete')return;
        await cloudCall('',{action,handoffId:id,expectedGeneration:state.generation});
        const end=Date.now()+(config.healthTimeoutMs||30000);
        while(Date.now()<end){state=await checkedStatus(cloudCall,false);if(state.handoffId===id&&state.billingMode===mode&&state.phase==='active'&&state.operation?.state==='complete')return;await sleep(250);}
        throw Error('Peer mode change timed out.');
      }
      const local={status:()=>checkedStatus(localCall,true),pause:async id=>{
        const old=await binding();
        if(old.handoffId===id&&old.billingMode==='standby'&&old.phase==='active')return;
        await atomic(config.bindingPath,{...old,phase:'validating',billingMode:'standby',handoffId:id,generation:old.generation+1});
        await waitReady(old.activationId,{drained:true});
        await atomic(config.bindingPath,{...await binding(),phase:'active'});
      },activate:async id=>{
        const old=await binding();if(old.handoffId!==id||old.billingMode!=='standby')throw Error('Local handoff identity changed.');
        await atomic(config.bindingPath,{...old,phase:'validating'});await waitReady(old.activationId,{drained:true});
        await atomic(config.bindingPath,{...old,phase:'active',billingMode:'active',generation:old.generation+1,reconciliationRequired:false});
      }};
      await executeBillingHandoff({id:request.id,target:request.kind==='use-cloud'?'cloud':'local',local,cloud:{status:()=>checkedStatus(cloudCall,false),pause:id=>remoteMode(id,'pause'),activate:id=>remoteMode(id,'activate')},transfer:id=>localCall('/flush',{handoffId:id}),record:async state=>{op.state=state;await record(op);}});
      const latest=await binding();
      await atomic(config.bindingPath,{...latest,handoffId:null});
      await fs.unlink(requestPath);
    }catch(error){
      // Never activate local as a rollback: cloud activation may have committed
      // despite a lost reply. Keep local paused unless it already was activated.
      const latest=await binding();
      if(latest.handoffId===request.id)await atomic(config.bindingPath,{...latest,phase:'active',handoffId:null});
      const reasons={'Both enrolled servers must remain paused for handoff.':'hold-changed','Handoff write leases did not drain.':'writes-busy','Synchronization is busy or blocked; billing remains paused.':'sync-blocked','Handoff endpoint unavailable.':'peer-endpoint-unavailable','Peer mode change timed out.':'peer-mode-timeout','Activation outcome requires inspection; do not enable the other server.':'activation-unconfirmed'};
      await record({...op,state:'failed',failedStage:op.state,failureCode:reasons[error.message]||'verification-failed',message:'Switch not confirmed. Inspect both billing modes. Pending data was retained; no alternate server was automatically activated.'});
      await fs.unlink(requestPath);
    }
  }
  async function rollback(operation){
    const old=validate(await json(rollbackPath),config.shopId);
    const current=await binding();
    // Never revert a database that has already been opened for new billing.
    if(current.phase==='active'&&current.activationId!==old.activationId)throw Error('New database may contain sales; automatic rollback is prohibited.');
    if(current.activationId===old.activationId&&operation.state==='preparing'){
      await atomic(config.bindingPath,old);
      await record({...operation,state:'rolled-back',message:'Activation stopped before service restart. Previous billing state retained.'});
      return;
    }
    await runCommand(config.stop);
    await atomic(config.bindingPath,{...old,phase:'validating'});
    await runCommand(config.start);await waitReady(old.activationId);
    await atomic(config.bindingPath,old);
    await record({...operation,state:'rolled-back',message:'Previous database restored. The recovery database was retained.'});
  }
  async function tick(){
    await fs.mkdir(config.directory,{recursive:true,mode:0o700});
    let request;try{request=await json(requestPath);}catch(error){if(error.code==='ENOENT')return;throw error;}
    if(request.shopId!==config.shopId||!['activate-restore','standby','emergency-local','emergency-cloud','use-cloud','use-local','handoff-standby','handoff-active'].includes(request.kind)||!/^[a-f0-9-]{36}$/.test(request.id||''))throw Error('Invalid recovery request.');
    let operation;try{operation=await json(operationPath);}catch(error){if(error.code!=='ENOENT')throw error;}
    if(['use-cloud','use-local'].includes(request.kind))return coordinated(request,operation?.id===request.id?operation:null);
    if(operation?.id===request.id){
      if(!terminal.has(operation.state)){
        const current=await binding();
        if(operation.state==='committing'&&current.phase==='active'&&current.activationId===operation.targetId){await record({...operation,state:'complete'});}
        else {await rollback(operation);}
      }
      await fs.unlink(requestPath);return;
    }
    operation={id:request.id,kind:request.kind,actor:request.actor,shopId:config.shopId,state:'preparing',startedAt:new Date().toISOString()};
    let frozen=false,committed=false;
    try{
      const old=await binding();
      if(old.generation!==request.expectedGeneration)throw Error('Runtime state changed.');
      let candidate;
      if(request.kind==='activate-restore'){
        if(config.nodeRole!=='local-server')throw Error('Restore activation is local only.');
        if(!/^[a-f0-9-]{36}$/.test(request.jobId||''))throw Error('Invalid restore job.');
        const job=await json(path.join(config.restoreJobDirectory,request.jobId+'.json'));
        const restore=await json(config.restoreConfigPath);
        if(job.shopId!==config.shopId||restore.shopId!==config.shopId||job.state!=='verified'||job.result?.database!==restore.database||job.result.activated!==false||!/^badizo_recovery_[a-z0-9]{8,32}$/.test(restore.database)||old.database.database===restore.database)throw Error('Restore is not eligible for activation.');
        candidate=validate({...old,activationId:crypto.randomUUID(),generation:old.generation+1,phase:'validating',billingMode:'active',reconciliationRequired:true,database:{host:restore.host,user:restore.user,password:restore.password,database:restore.database}},config.shopId);
        await verify(candidate,job.result);
      }else{
        if(request.kind.startsWith('handoff-')){
          if(!['cloud-active','cloud-standby'].includes(config.nodeRole)||!/^[a-f0-9-]{36}$/.test(request.handoffId||''))throw Error('Invalid peer handoff.');
          if(request.kind==='handoff-active'&&(old.handoffId!==request.handoffId||old.billingMode!=='standby'))throw Error('Handoff pause does not match.');
        }
        if(request.kind==='emergency-cloud'&&!['cloud-active','cloud-standby'].includes(config.nodeRole))throw Error('Cloud activation is cloud only.');
        if(request.kind==='emergency-local'&&config.nodeRole!=='local-server')throw Error('Emergency local billing is local only.');
        candidate={...old,generation:old.generation+1,phase:'active',billingMode:['standby','handoff-standby'].includes(request.kind)?'standby':'active',handoffId:request.kind.startsWith('handoff-')?request.handoffId:null,reconciliationRequired:request.kind.startsWith('emergency-')?true:old.reconciliationRequired,preferLocalConflicts:request.kind==='emergency-local'?true:!!old.preferLocalConflicts};
      }
      await atomic(rollbackPath,old);
      operation.targetId=candidate.activationId;await record(operation);
      await atomic(config.bindingPath,{...old,phase:'validating'});frozen=true;
      await waitReady(old.activationId,{drained:true});
      if(request.kind==='activate-restore'){
        operation.state='starting';await record(operation);
        await runCommand(config.stop);
        await atomic(config.bindingPath,candidate);
        await runCommand(config.start);
        await waitReady(candidate.activationId);
      }
      operation.state='committing';await record(operation);
      await atomic(config.bindingPath,{...candidate,phase:'active'});committed=true;
      await record({...operation,state:'complete',message:request.kind==='activate-restore'?'Recovery database activated. Previous database retained.':'Billing mode updated. Reconciliation status is shown separately.'});
      await fs.unlink(requestPath);
    }catch{
      if(committed)throw Error('Activation committed; preserve the journal for restart recovery.');
      if(frozen){try{await rollback(operation);await fs.unlink(requestPath);return;}catch{}}
      await record({...operation,state:'failed',message:'Recovery did not complete. Inspect the supervisor before retrying; databases were retained.'});
      // A failed rollback keeps the request and paused binding for inspection.
      if(!frozen)await fs.unlink(requestPath);
    }
  }
  return {tick};
}
module.exports={createRecoverySupervisor,verifyDatabase};
