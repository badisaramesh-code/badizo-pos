// Prepared recovery copies are activated by each host's own supervisor.
// Network requests carry an operation identity, never database credentials or paths.
const fs=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto');
const mysql=require('mysql2/promise');
const {atomic,json}=require('./recoveryControlFiles');
const {validate}=require('./recoveryRuntimeBinding');
const {validateConfiguration}=require('./enrolledSyncRuntime');
const {fingerprintBusiness}=require('./recoveryBaselineEnrollment');
const uuid=value=>/^[a-f0-9-]{36}$/.test(value||'');
const sha=value=>/^[a-f0-9]{64}$/.test(value||'');
async function loadPlan(config){
  if(!path.isAbsolute(config.baselinePlanPath||'')||!path.isAbsolute(config.enrollmentConfigPath||''))throw Error('Prepared recovery plan is not configured.');
  const plan=await json(config.baselinePlanPath),report=await json(plan.reportPath);
  if(config.preparationConfigPath){
    const preparation=require('./recoveryPreparation').createRecoveryPreparation(config);
    if((await preparation.status(plan.operationId)).state==='cancelled')throw Error('This recovery operation was cancelled. Prepare a new verified snapshot.');
  }
  const local=config.nodeRole==='local-server',index=local?0:1;
  if(plan.schemaVersion!==1||plan.shopId!==config.shopId||plan.side!==index||!['verified-copy','lost-local-copy'].includes(plan.mode)||!uuid(plan.operationId)||!path.isAbsolute(plan.reportPath||'')||!sha(plan.incomingToken)
    ||report.state!=='prepared-disabled'||report.shopId!==config.shopId||report.operationId!==plan.operationId||report.sourceShopIdentityVerified!==true||report.readyForProtectedEnrollment!==true||!sha(report.businessFingerprint?.hash)||!sha(report.baselineId)
    ||!report.prepared?.every(Boolean)||report.prepared.length!==2||!uuid(report.activationIds?.[index])||!report.installationIds?.[index])throw Error('Prepared recovery plan or identity is invalid.');
  const candidate=validate({schemaVersion:1,shopId:config.shopId,activationId:report.activationIds[index],generation:0,phase:'validating',billingMode:'standby',database:plan.database},config.shopId);
  if(candidate.database.database!==report.databases[index]||!/^badizo_recovery_[a-z0-9_]{8,50}$/.test(candidate.database.database))throw Error('Candidate differs from the prepared report.');
  if(!uuid(plan.sourceActivationId))throw Error('Original source activation identity required.');
  if(local){
    const url=new URL(plan.peer?.url);
    if(url.protocol!=='https:'||url.username||url.password||url.search||url.hash||url.pathname!=='/api/recovery-baseline'||!sha(plan.peer?.token))throw Error('A secured cloud recovery endpoint is required.');
  }else if(plan.peer!==null)throw Error('Only local coordinates recovery.');
  return {plan,report,index,candidate};
}
async function nodeStatus(config){
  const {plan,report,index}=await loadPlan(config),binding=validate(await json(config.bindingPath),config.shopId);
  let journal=null;try{journal=await json(path.join(config.directory,'baseline-node.json'));}catch(error){if(error.code!=='ENOENT')throw error;}
  return {shopId:config.shopId,operationId:plan.operationId,mode:plan.mode,baselineId:report.baselineId,businessHash:report.businessFingerprint.hash,side:index,
    state:journal?.operationId===plan.operationId?journal.state:'prepared',sourceVerified:journal?.operationId===plan.operationId&&journal.sourceVerified===true,
    dataLossAcknowledged:journal?.operationId===plan.operationId&&journal.dataLossAcknowledged===true,
    activationId:binding.activationId,candidateActivationId:report.activationIds[index],generation:binding.generation,phase:binding.phase,billingMode:binding.billingMode,
    held:binding.handoffId===plan.operationId,installed:binding.activationId===report.activationIds[index]&&binding.database.database===report.databases[index]};
}
async function fingerprint(database){
  const connection=await mysql.createConnection({...database,connectTimeout:10000});
  try{return await fingerprintBusiness(connection);}finally{await connection.end();}
}
async function enableCandidate(database,{plan,report,index}){
  const connection=await mysql.createConnection({...database,connectTimeout:10000});
  try{
    const [rows]=await connection.execute('SELECT * FROM sync_enrollment WHERE singleton=1');const row=rows[0];
    if(rows.length!==1||row.shop_id!==plan.shopId||row.installation_id!==report.installationIds[index]||row.peer_installation_id!==report.installationIds[1-index]||row.baseline_id!==report.baselineId||row.activation_id!==report.activationIds[index]||Number(row.contract_version)!==1)throw Error('Candidate enrollment does not match the prepared pair.');
    await connection.execute('UPDATE sync_enrollment SET enabled=1 WHERE singleton=1');
  }finally{await connection.end();}
}
function createBaselineActivation(config,{runCommand,waitReady,acquireDatabaseFence,inspect=fingerprint,enable=enableCandidate,callPeer,verifySyncPeer}={}){
  const journalPath=path.join(config.directory,'baseline-node.json');
  async function current(){return validate(await json(config.bindingPath),config.shopId);}
  async function writeJournal(value){await atomic(journalPath,{...value,updatedAt:new Date().toISOString()});}
  async function pause(operationId){
    const {plan,report}=await loadPlan(config);if(plan.operationId!==operationId)throw Error('Recovery operation changed.');
    let old=await current();
    if(old.activationId===report.activationIds[plan.side])return;
    if(old.activationId!==plan.sourceActivationId||old.handoffId&&old.handoffId!==operationId)throw Error('Original source changed or another switch owns it.');
    await atomic(config.bindingPath,{...old,phase:'validating',billingMode:'standby',handoffId:operationId,generation:old.generation+1});
    await waitReady(old.activationId,{drained:true});
  }
  async function stage(operationId,{acknowledgeLostLocal=false}={}){
    const context=await loadPlan(config),{plan,report,index,candidate}=context;
    if(plan.operationId!==operationId)throw Error('Recovery operation changed.');
    if(plan.mode==='lost-local-copy'&&index===0&&!acknowledgeLostLocal)throw Error('Lost local data requires explicit owner acknowledgement.');
    let journal;try{journal=await json(journalPath);}catch(error){if(error.code!=='ENOENT')throw error;}
    if(journal&&journal.operationId!==operationId&&!['complete','released'].includes(journal.state))throw Error('An older recovery journal requires inspection.');
    const before=await current();
    const resumeInstalling=journal?.operationId===operationId&&journal.state==='installing'&&journal.sourceVerified===true;
    if(before.activationId===candidate.activationId){
      if(!journal||journal.operationId!==operationId||!journal.sourceVerified)throw Error('Candidate has no verified source journal.');
      if(before.billingMode==='active')return nodeStatus(config); // Never roll back a database which may contain bills.
    }else if(resumeInstalling){
      // The process may be stopped after the enrollment file changed but
      // before the binding did. The durable verified hold is the resume proof;
      // asking that stopped old process for HTTP readiness would deadlock.
      if(before.activationId!==plan.sourceActivationId||before.phase!=='validating'||before.billingMode!=='standby'||before.handoffId!==operationId)throw Error('Interrupted recovery lost its original source hold.');
      await runCommand(config.stop);
    }else await pause(operationId);
    const release=await acquireDatabaseFence(candidate);
    try{
      if(before.activationId!==candidate.activationId){
        const held=await current();
        if(held.phase!=='validating'||held.billingMode!=='standby'||held.handoffId!==operationId)throw Error('Original source hold was lost.');
        // The explicit lost-local copy path never claims the old local data was
        // merged. The cloud side ALWAYS checks its final paused source in full.
        if(!(index===0&&plan.mode==='lost-local-copy')){
          if((await inspect(held.database)).hash!==report.businessFingerprint.hash)throw Error('Source changed since the snapshot. Export a fresh paused copy or reconcile local changes first.');
        }
        if((await inspect(candidate.database)).hash!==report.businessFingerprint.hash)throw Error('Candidate business records changed.');
        const enrollment=validateConfiguration(await json(config.enrollmentConfigPath),{BADIZO_SHOP_ID:config.shopId,BADIZO_NODE_ROLE:config.nodeRole});
        if(!journal||journal.operationId!==operationId)journal={operationId,state:'source-verified',sourceVerified:true,dataLossAcknowledged:index===0&&plan.mode==='lost-local-copy',originalBinding:held,originalEnrollment:enrollment};
        // Private journal retains original pointers; neither original DB is deleted.
        await writeJournal(journal);
      }
      if((await inspect(candidate.database)).hash!==report.businessFingerprint.hash)throw Error('Candidate changed while awaiting activation.');
      const original=journal.originalEnrollment;
      const enrollment=validateConfiguration({...original,shopId:config.shopId,installationId:report.installationIds[index],peerInstallationId:report.installationIds[1-index],databaseName:candidate.database.database,activationId:candidate.activationId,baselineId:report.baselineId}, {BADIZO_SHOP_ID:config.shopId,BADIZO_NODE_ROLE:config.nodeRole});
      await enable(candidate.database,context);
      journal.state='installing';await writeJournal(journal);
      await runCommand(config.stop);
      await atomic(config.enrollmentConfigPath,enrollment);
      const old=await current();
      await atomic(config.bindingPath,{...old,...candidate,generation:old.generation+1,handoffId:operationId,reconciliationRequired:plan.mode==='lost-local-copy',preferLocalConflicts:true});
      await runCommand(config.start);await waitReady(candidate.activationId,{drained:true});
      await atomic(config.bindingPath,{...await current(),phase:'active',billingMode:'standby'});
      const ready=await waitReady(candidate.activationId,{drained:true});
      if(ready.sync?.ready!==true||ready.sync.shopId!==config.shopId||ready.sync.baselineId!==report.baselineId||ready.sync.installationId!==report.installationIds[index]||ready.sync.peerInstallationId!==report.installationIds[1-index])throw Error('Candidate synchronization runtime is not verified.');
      journal.state='installed-standby';await writeJournal(journal);
      return nodeStatus(config);
    }finally{await release();}
  }
  async function peer(action){
    if(callPeer)return callPeer(action);
    const {plan}=await loadPlan(config);
    const response=await fetch(plan.peer.url,{method:action?'POST':'GET',redirect:'error',signal:AbortSignal.timeout(10000),headers:{Authorization:'Bearer '+plan.peer.token,'Content-Type':'application/json'},...(action?{body:JSON.stringify({action,operationId:plan.operationId})}:{})});
    if(!response.ok){await response.body?.cancel();throw Error('Cloud recovery endpoint is unavailable.');}
    const raw=await response.text();if(raw.length>16384)throw Error('Invalid cloud recovery response.');return JSON.parse(raw);
  }
  function verifyPeer(state,context){
    const {plan,report}=context;
    if(state.shopId!==config.shopId||state.operationId!==plan.operationId||state.mode!==plan.mode||state.baselineId!==report.baselineId||state.businessHash!==report.businessFingerprint.hash||state.side!==1)throw Error('Cloud recovery identity differs.');
    return state;
  }
  async function waitPeer(expected,context){
    const deadline=Date.now()+(config.baselineTimeoutMs||120000);
    while(Date.now()<deadline){
      let value;
      try{value=verifyPeer(await peer(),context);if(expected(value))return value;}catch{}
      if(value?.operation?.state==='failed'&&value.operation.kind==='baseline-stage')throw Error(value.operation.message==='Source changed since the snapshot. Export a fresh paused copy or reconcile local changes first.'?value.operation.message:'Cloud recovery failed. Inspect its recovery status before retrying.');
      await new Promise(resolve=>setTimeout(resolve,500));
    }
    throw Error('Cloud recovery did not confirm the requested state. Keep billing paused and retry.');
  }
  async function release(operationId){
    const {plan}=await loadPlan(config);if(plan.operationId!==operationId||config.nodeRole==='local-server')throw Error('Invalid cloud recovery release.');
    const state=await nodeStatus(config);if(!state.installed||!state.sourceVerified||state.billingMode!=='standby')throw Error('Cloud is not a verified standby.');
    const journal=await json(journalPath);journal.state='released';await writeJournal(journal);
    await atomic(config.bindingPath,{...await current(),handoffId:null});
  }
  async function reconnect({acknowledgeLostLocal=false,record=async()=>{}}={}){
    const context=await loadPlan(config),{plan,report}=context;if(config.nodeRole!=='local-server')throw Error('Start recovery on local.');
    if(plan.mode==='lost-local-copy'&&!acknowledgeLostLocal)throw Error('Lost local data acknowledgement required.');
    let state=await nodeStatus(config);
    if(!(state.installed&&state.billingMode==='active')){
      await record('pausing-local');
      let localJournal;try{localJournal=await json(journalPath);}catch(error){if(error.code!=='ENOENT')throw error;}
      if(localJournal?.operationId!==plan.operationId||localJournal.state!=='installing')await pause(plan.operationId);
      await record('verifying-cloud');verifyPeer(await peer(),context);
      await peer('stage');
      await waitPeer(value=>value.installed&&value.sourceVerified&&value.runtimeReady&&value.activeWrites===0&&value.held&&value.billingMode==='standby'&&value.phase==='active',context);
      await record('installing-local');await stage(plan.operationId,{acknowledgeLostLocal});
      await record('verifying-pair');
      const remote=verifyPeer(await peer(),context);state=await nodeStatus(config);
      if(!remote.installed||!remote.sourceVerified||!remote.runtimeReady||remote.activeWrites!==0||!remote.held||remote.billingMode!=='standby'||remote.phase!=='active'||!state.installed||!state.held||state.billingMode!=='standby'||state.phase!=='active')throw Error('Both prepared copies must remain paused before local billing resumes.');
      const enrollment=await json(config.enrollmentConfigPath);
      if(verifySyncPeer)await verifySyncPeer(enrollment);
      else{
        const response=await fetch(enrollment.peer.baseUrl.replace(/\/$/,'')+'/status',{redirect:'error',signal:AbortSignal.timeout(10000),headers:{Authorization:'Bearer '+enrollment.peer.token,'X-Badizo-Baseline':enrollment.baselineId}});
        if(!response.ok){await response.body?.cancel();throw Error('New synchronization handshake failed.');}
        const text=await response.text();if(text.length>8192)throw Error('Invalid synchronization handshake.');
        const peer=JSON.parse(text);if(peer.ready!==true||peer.shopId!==config.shopId||peer.baselineId!==report.baselineId||peer.installationId!==report.installationIds[1]||peer.peerInstallationId!==report.installationIds[0])throw Error('New synchronization handshake differs.');
      }
      // Fresh baselines use new activation/installation IDs. A failed restart or
      // lost response cannot authorize the old cloud writer.
      await waitReady(report.activationIds[0],{drained:true});
      await atomic(config.bindingPath,{...await current(),phase:'active',billingMode:'active',handoffId:plan.operationId,generation:state.generation+1});
      const journal=await json(journalPath);journal.state='local-active';await writeJournal(journal);
    }
    await record('releasing-cloud-standby');await peer('release');
    await waitPeer(value=>value.installed&&value.runtimeReady&&value.billingMode==='standby'&&value.state==='released'&&!value.held,context);
    await atomic(config.bindingPath,{...await current(),handoffId:null});
    const journal=await json(journalPath);journal.state='complete';await writeJournal(journal);
    await record('complete');return {complete:true,mode:plan.mode,localActive:true,cloudStandby:true,dataLossAcknowledged:plan.mode==='lost-local-copy'};
  }
  return {pause,stage,release,reconnect,status:()=>nodeStatus(config)};
}
module.exports={loadPlan,nodeStatus,createBaselineActivation,fingerprint,enableCandidate};
