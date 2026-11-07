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
async function lockRecoveryDatabase(binding){
  const connection=await mysql.createConnection({...binding.database,connectTimeout:10000});
  try{
    const [[locked]]=await connection.execute('SELECT GET_LOCK(?,0) AS acquired',['badizo-rebuild:'+binding.database.database]);
    if(Number(locked.acquired)!==1)throw Error('Recovery reconstruction is still using this database.');
    // Closing the dedicated connection releases the fence, including crashes.
    return async()=>{await connection.end();};
  }catch(error){await connection.end().catch(()=>{});throw error;}
}
function createRecoverySupervisor(config,{runCommand=command,verify=verifyDatabase,fetchReady,acquireDatabaseFence=lockRecoveryDatabase}={}){
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
    let inspectModes=null;
    async function checkpoint(){
      let stop;
      try{stop=await json(path.join(config.directory,'switch-stop-'+request.id+'.json'));}
      catch(error){if(error.code==='ENOENT')return;throw error;}
      if(stop.id!==request.id||stop.shopId!==config.shopId)throw Error('Invalid stop record.');
      throw Object.assign(Error('The owner requested stopping this switch.'),{code:'OWNER_STOPPED'});
    }
    try{
      if(config.nodeRole!=='local-server'||!path.isAbsolute(config.enrollmentConfigPath||''))throw Error('Local enrolled supervisor required.');
      const enrollment=require('./enrolledSyncRuntime').validateConfiguration(await json(config.enrollmentConfigPath),{BADIZO_SHOP_ID:config.shopId,BADIZO_NODE_ROLE:config.nodeRole});
      const current=await binding();
      if(await require('./captureGap').hasCaptureGap(config.bindingPath,current))throw Error('Local billing continued with sync paused. Verify a new baseline before switching.');
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
        if(action==='pause'&&state.generation!==op.cloudGeneration)throw Error('Cloud authority changed after the switch started.');
        await checkpoint();
        await cloudCall('',{action,handoffId:id,expectedGeneration:state.generation});
        const end=Date.now()+(config.healthTimeoutMs||30000);
        while(Date.now()<end){state=await checkedStatus(cloudCall,false);if(state.handoffId===id&&state.billingMode===mode&&state.phase==='active'&&state.operation?.state==='complete')return;await sleep(250);}
        throw Error('Peer mode change timed out.');
      }
      const local={status:()=>checkedStatus(localCall,true),pause:async id=>{
        const old=await binding();
        if(await require('./captureGap').hasCaptureGap(config.bindingPath,old))throw Error('A verified recovery baseline is required before pausing local billing.');
        if(old.handoffId===id&&old.billingMode==='standby'&&old.phase==='active')return;
        if(old.generation!==request.expectedGeneration)throw Error('Local authority changed after the switch started.');
        await atomic(config.bindingPath,{...old,phase:'validating',billingMode:'standby',handoffId:id,generation:old.generation+1});
        await waitReady(old.activationId,{drained:true});
        await atomic(config.bindingPath,{...await binding(),phase:'active'});
      },activate:async id=>{
        const old=await binding();if(old.handoffId!==id||old.billingMode!=='standby')throw Error('Local handoff identity changed.');
        await atomic(config.bindingPath,{...old,phase:'validating'});await waitReady(old.activationId,{drained:true});
        await checkpoint();
        await atomic(config.bindingPath,{...old,phase:'active',billingMode:'active',generation:old.generation+1,reconciliationRequired:false});
      }};
      const observe=()=>Promise.allSettled([local.status(),checkedStatus(cloudCall,false)]);
      inspectModes=async()=>{
        const modes=(await observe()).map(result=>result.status==='fulfilled'&&result.value.phase==='active'&&['active','standby'].includes(result.value.billingMode)?result.value.billingMode:'unknown');
        return {local:modes[0],cloud:modes[1]};
      };
      const target=request.kind==='use-cloud'?'cloud':'local';
      if(existing?.state==='activating-'+target){
        // The activation command may already have committed. Inspect only.
        const nodes=await observe(),active=nodes[target==='local'?0:1].value,standby=nodes[target==='local'?1:0].value;
        if(active?.handoffId!==request.id||active.phase!=='active'||active.billingMode!=='active'||standby?.handoffId!==request.id||standby.phase!=='active'||standby.billingMode!=='standby'||standby.activeWrites!==0)throw Error('Activation outcome requires inspection; do not enable the other server.');
        await record({...op,state:'complete'});
      } else {
        await checkpoint();
        if(existing)throw Error('Interrupted handoff requires a fresh owner decision.');
        const [beforeLocal,beforeCloud]=await Promise.all([local.status(),checkedStatus(cloudCall,false)]);
        if(beforeLocal.generation!==request.expectedGeneration||beforeLocal.phase!=='active'||beforeCloud.phase!=='active'||!Number.isSafeInteger(beforeCloud.generation))throw Error('Handoff preflight requires both enrolled servers.');
        op.cloudGeneration=beforeCloud.generation;
        await record(op);
        await executeBillingHandoff({id:request.id,target,local,cloud:{status:()=>checkedStatus(cloudCall,false),pause:id=>remoteMode(id,'pause'),activate:id=>remoteMode(id,'activate')},checkpoint,transfer:id=>localCall('/flush',{handoffId:id}),record:async state=>{op.state=state;await record(op);}});
      }
      const latest=await binding();
      await atomic(config.bindingPath,{...latest,handoffId:null});
      await fs.unlink(requestPath);
    }catch(error){
      // Never activate local as a rollback: cloud activation may have committed
      // despite a lost reply. Keep local paused unless it already was activated.
      const latest=await binding();
      if(latest.handoffId===request.id)await atomic(config.bindingPath,{...latest,phase:'active',handoffId:null});
      const reasons={'Both enrolled servers must remain paused for handoff.':'hold-changed','Handoff write leases did not drain.':'writes-busy','Synchronization is busy or blocked; billing remains paused.':'sync-blocked','Handoff endpoint unavailable.':'peer-endpoint-unavailable','Peer mode change timed out.':'peer-mode-timeout','Activation outcome requires inspection; do not enable the other server.':'activation-unconfirmed'};
      const observedModes=inspectModes?await inspectModes():{local:'unknown',cloud:'unknown'};
      const failureCode=error.code==='OWNER_STOPPED'?'owner-stopped':op.state.startsWith('activating-')?'activation-unconfirmed':reasons[error.message]||'verification-failed';
      await record({...op,state:'failed',failedStage:op.state,failureCode,observedModes,message:'Check both billing modes. Before emergency billing, stop the other server. Pending changes were retained.'});
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
    if(request.shopId!==config.shopId||!['activate-restore','standby','emergency-local','emergency-cloud','use-cloud','use-local','handoff-standby','handoff-active','reconnect-baseline','copy-lost-local','baseline-stage','baseline-release','prepare-baseline','prepare-lost-local','prepare-export','finish-recovery-cancel'].includes(request.kind)||!/^[a-f0-9-]{36}$/.test(request.id||''))throw Error('Invalid recovery request.');
    let operation;try{operation=await json(operationPath);}catch(error){if(error.code!=='ENOENT')throw error;}
    if(['prepare-baseline','prepare-lost-local','prepare-export','finish-recovery-cancel'].includes(request.kind)){
      const op={id:request.id,kind:request.kind,handoffId:request.handoffId||null,mode:request.mode||null,actor:request.actor,shopId:config.shopId,state:'preparing',startedAt:operation?.id===request.id?operation.startedAt:new Date().toISOString()};
      try{
        if(operation?.id!==request.id&&(await binding()).generation!==request.expectedGeneration)throw Error('Runtime state changed.');
        const adapters={runCommand,waitReady,acquireDatabaseFence},preparation=require('./recoveryPreparation').createRecoveryPreparation(config,adapters);
        await record(op);
        if(request.kind==='finish-recovery-cancel')await preparation.finishCancellation();
        else if(request.kind==='prepare-export')await preparation.export(request.handoffId,request.mode);
        else{
          const notify=async state=>{op.state=state;await record(op);};
          const acknowledgeLostLocal=request.kind==='prepare-lost-local';
          await preparation.prepare({acknowledgeLostLocal,record:notify});
          await require('./recoveryBaselineActivation').createBaselineActivation(config,adapters).reconnect({acknowledgeLostLocal,record:notify});
        }
        await record({...op,state:'complete',message:request.kind==='finish-recovery-cancel'?'Cancelled cloud recovery hold cleared. Cloud remains standby; use Sync Local and Cloud to exchange pending changes.':request.kind==='prepare-export'?'Cloud snapshot and candidate are verified. Cloud remains paused.':request.kind==='prepare-lost-local'?'Cloud copy recovery completed. Local billing and synchronization are ready; cloud is standby. Original local data was retained separately, not merged.':'Verified recovery completed. Local billing and synchronization are ready; cloud is standby.'});
      }catch(error){
        const known=['Source changed since the snapshot. Export a fresh paused copy or reconcile local changes first.','Insufficient disk space for recovery. Free space before retrying.'];
        let installing=false;try{installing=(await json(path.join(config.directory,'baseline-node.json'))).state==='installing';}catch{}
        await record({...op,state:installing?'retrying':'failed',message:known.includes(error.message)?error.message:'Recovery preparation or reconnection did not finish. Original databases and recovery files were retained. Check recovery status and retry; do not start billing on both servers.'});
        if(installing)return;
      }
      await fs.unlink(requestPath);return;
    }
    if(['reconnect-baseline','copy-lost-local','baseline-stage','baseline-release'].includes(request.kind)){
      const op={id:request.id,kind:request.kind,handoffId:request.handoffId||null,actor:request.actor,shopId:config.shopId,state:'preparing',startedAt:operation?.id===request.id?operation.startedAt:new Date().toISOString()};
      try{
        if(operation?.id!==request.id&&(await binding()).generation!==request.expectedGeneration)throw Error('Runtime state changed.');
        const recovery=require('./recoveryBaselineActivation').createBaselineActivation(config,{runCommand,waitReady,acquireDatabaseFence});
        const context=await require('./recoveryBaselineActivation').loadPlan(config);
        if(request.kind.startsWith('baseline-')&&request.handoffId!==context.plan.operationId)throw Error('Recovery identity changed.');
        await record(op);
        if(request.kind==='baseline-stage')await recovery.stage(context.plan.operationId);
        else if(request.kind==='baseline-release')await recovery.release(context.plan.operationId);
        else await recovery.reconnect({acknowledgeLostLocal:request.kind==='copy-lost-local',record:async state=>{op.state=state;await record(op);}});
        await record({...op,state:'complete',message:request.kind==='copy-lost-local'?'Cloud copy recovery completed. Local is active; cloud is standby. Unrecoverable local changes were not merged.':request.kind==='reconnect-baseline'?'Verified pair reconnected. Local is active and cloud is standby.':'Prepared recovery node step completed.'});
      }catch(error){
        const known=['Source changed since the snapshot. Export a fresh paused copy or reconcile local changes first.','Candidate business records changed.','Candidate changed while awaiting activation.','Cloud recovery did not confirm the requested state. Keep billing paused and retry.'];
        let installing=false;
        try{const journal=await json(path.join(config.directory,'baseline-node.json'));installing=journal.state==='installing';}catch{}
        await record({...op,state:installing?'retrying':'failed',message:known.includes(error.message)?error.message:'Recovery is not confirmed. Both original databases were retained. Inspect the prepared recovery status and retry the same operation; do not start cloud billing.'});
        // Configuration/binding may have changed while the application was
        // stopped. Keep the request so the independent supervisor can recover
        // even if the application HTTP endpoint cannot start yet.
        if(installing)return;
      }
      await fs.unlink(requestPath);return;
    }
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
    let frozen=false,committed=false,releaseDatabaseFence=null;
    try{
      const old=await binding();
      if(old.generation!==request.expectedGeneration)throw Error('Runtime state changed.');
      if(request.kind==='emergency-local'&&old.handoffId&&config.preparationConfigPath){
        // Explicit owner confirmation may resume the unchanged original local
        // database after a FAILED preparation, even without internet. Never
        // use this path to roll back an installed or possibly used candidate.
        const preparation=require('./recoveryPreparation').createRecoveryPreparation(config,{runCommand,waitReady,acquireDatabaseFence});
        const state=await preparation.status();
        if(state.operationId!==old.handoffId||state.canResumeOriginal!==true)throw Error('Original local recovery cannot be resumed safely.');
        await preparation.cancelLocalPreparation();
      }
      let candidate;
      if(request.kind==='activate-restore'){
        if(config.nodeRole!=='local-server')throw Error('Restore activation is local only.');
        if(!/^[a-f0-9-]{36}$/.test(request.jobId||''))throw Error('Invalid restore job.');
        const job=await json(path.join(config.restoreJobDirectory,request.jobId+'.json'));
        const restore=await json(config.restoreConfigPath);
        if(job.shopId!==config.shopId||restore.shopId!==config.shopId||job.state!=='verified'||job.result?.database!==restore.database||job.result.activated!==false||!/^badizo_recovery_[a-z0-9]{8,32}$/.test(restore.database)||old.database.database===restore.database)throw Error('Restore is not eligible for activation.');
        candidate=validate({...old,activationId:crypto.randomUUID(),generation:old.generation+1,phase:'validating',billingMode:'active',reconciliationRequired:true,database:{host:restore.host,user:restore.user,password:restore.password,database:restore.database}},config.shopId);
        releaseDatabaseFence=await acquireDatabaseFence(candidate);
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
    }finally{if(releaseDatabaseFence)await releaseDatabaseFence();}
  }
  return {tick};
}
module.exports={createRecoverySupervisor,verifyDatabase,lockRecoveryDatabase};
