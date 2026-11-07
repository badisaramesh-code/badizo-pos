const fs=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto');
const {json,atomic}=require('./recoveryControlFiles');
const {validate}=require('./recoveryRuntimeBinding');
function createRecoveryControl({configPath,shopId}){
  if(!path.isAbsolute(configPath||''))throw Error('Protected recovery supervisor configuration required.');
  async function config(){const value=await json(configPath);if(value.shopId!==shopId||!path.isAbsolute(value.directory||'')||!path.isAbsolute(value.bindingPath||''))throw Error('Recovery configuration mismatch.');return value;}
  async function status(){
    const c=await config(),binding=validate(await json(c.bindingPath),shopId);
    let operation=null,heartbeat=null;
    try{operation=await json(path.join(c.directory,'operation.json'));}catch(error){if(error.code!=='ENOENT')throw error;}
    try{
      const pending=await json(path.join(c.directory,'request.json'));
      if(pending.id!==operation?.id)operation={id:pending.id,kind:pending.kind,handoffId:pending.handoffId||null,mode:pending.mode||null,actor:pending.actor,state:'queued'};
      else if(['complete','rolled-back','failed'].includes(operation.state))operation={...operation,state:'finalizing'};
    }catch(error){if(error.code!=='ENOENT')throw error;}
    if(operation && ['use-local','use-cloud'].includes(operation.kind) && /^[a-f0-9-]{36}$/.test(operation.id)){
      try{operation.stopRequested=(await json(path.join(c.directory,'switch-stop-'+operation.id+'.json'))).id===operation.id;}
      catch(error){if(error.code!=='ENOENT')throw error;}
    }
    try{heartbeat=await json(path.join(c.directory,'heartbeat.json'));}catch(error){if(error.code!=='ENOENT')throw error;}
    let baseline=null;
    if(c.baselinePlanPath){try{baseline=await require('./recoveryBaselineActivation').nodeStatus(c);}catch(error){if(error.code!=='ENOENT')baseline={state:'configuration-needs-inspection'};}}
    let preparation=null;
    if(c.preparationConfigPath){try{preparation=await require('./recoveryPreparation').createRecoveryPreparation(c).status();delete preparation.metadata;}catch{preparation={state:'configuration-needs-inspection'};}}
    return {configured:true,nodeRole:c.nodeRole,handoffAvailable:!!c.enrollmentConfigPath&&c.nodeRole==='local-server'&&!await require('./captureGap').hasCaptureGap(c.bindingPath,binding),baseline,preparation,handoffId:binding.handoffId||null,supervisorOnline:heartbeat?.shopId===shopId&&Date.now()-Date.parse(heartbeat.at)<15000,generation:binding.generation,phase:binding.phase,billingMode:binding.billingMode,reconciliationRequired:!!binding.reconciliationRequired,operation};
  }
  async function request({kind,jobId,handoffId,mode,expectedGeneration,actor}){
    if(!['activate-restore','standby','emergency-local','emergency-cloud','use-cloud','use-local','handoff-standby','handoff-active','reconnect-baseline','copy-lost-local','baseline-stage','baseline-release','prepare-baseline','prepare-lost-local','prepare-export','finish-recovery-cancel'].includes(kind)||!Number.isSafeInteger(expectedGeneration)||typeof actor!=='string'||!actor.trim())throw Error('Invalid recovery operation.');
    if(kind.startsWith('handoff-')&&!/^[a-f0-9-]{36}$/.test(handoffId||''))throw Error('Handoff identity required.');
    if(kind==='activate-restore'&&!/^[a-f0-9-]{36}$/.test(jobId||''))throw Error('A verified restore job is required.');
    const c=await config(),state=await status();
    if(!state.supervisorOnline||state.generation!==expectedGeneration)throw Error('Supervisor unavailable or state changed.');
    const baselineKind=['reconnect-baseline','copy-lost-local','baseline-stage','baseline-release'].includes(kind);
    const preparationKind=['prepare-baseline','prepare-lost-local','prepare-export','finish-recovery-cancel'].includes(kind);
    const resumeOriginal=kind==='emergency-local'&&state.preparation?.canResumeOriginal===true&&['failed','rolled-back'].includes(state.operation?.state);
    if(state.phase!=='active'&&!baselineKind&&!preparationKind&&!resumeOriginal)throw Error('An unfinished activation requires inspection before another operation.');
    if((state.baseline?.held||state.handoffId&&state.preparation?.operationId===state.handoffId)&&!baselineKind&&!preparationKind&&!resumeOriginal)throw Error('Prepared recovery owns the billing hold. Resume that operation first.');
    if(preparationKind){
      const plan=await require('./recoveryPreparation').configuration(c);
      if(kind==='finish-recovery-cancel'){if(c.nodeRole!=='local-server'||!state.preparation?.pendingPeerCancel)throw Error('No cancelled cloud hold is awaiting cleanup.');}
      else if(kind==='prepare-export'){if(c.nodeRole==='local-server'||!/^[a-f0-9-]{36}$/.test(handoffId||'')||!plan.allowedModes.includes(mode))throw Error('Invalid preparation peer operation.');}
      else if(c.nodeRole!=='local-server'||!plan.allowedModes.includes(kind==='prepare-lost-local'?'lost-local-copy':'verified-copy'))throw Error('Choose an installed recovery mode explicitly.');
    }
    if(baselineKind){
      const {plan}=await require('./recoveryBaselineActivation').loadPlan(c);
      if(['reconnect-baseline','copy-lost-local'].includes(kind)&&(c.nodeRole!=='local-server'||(kind==='copy-lost-local')!==(plan.mode==='lost-local-copy')))throw Error('Choose the configured recovery mode explicitly.');
      if(kind.startsWith('baseline-')&&(c.nodeRole==='local-server'||handoffId!==plan.operationId))throw Error('Recovery peer identity differs.');
    }
    if(['use-cloud','use-local'].includes(kind)&&(!state.handoffAvailable))throw Error('Coordinated handoff must start on the enrolled local supervisor.');
    if(kind==='emergency-cloud'&&!['cloud-active','cloud-standby'].includes(c.nodeRole))throw Error('Cloud emergency billing is cloud only.');
    if(kind==='activate-restore'&&c.nodeRole!=='local-server')throw Error('Restore activation is local only.');
    if(kind==='emergency-local'&&c.nodeRole!=='local-server')throw Error('Emergency local billing is only available locally.');
    if(state.operation&&!['complete','rolled-back','failed'].includes(state.operation.state))throw Error('A recovery operation is already pending.');
    const value={id:crypto.randomUUID(),shopId,kind,jobId:jobId||null,handoffId:handoffId||null,mode:kind==='prepare-export'?mode:null,expectedGeneration,actor,requestedAt:new Date().toISOString()};
    const file=await fs.open(path.join(c.directory,'request.json'),'wx',0o600);
    try{await file.writeFile(JSON.stringify(value));await file.sync();}finally{await file.close();}
    return {id:value.id,state:'queued'};
  }
  async function recoverSwitch({operationId,actor}){
    if(!/^[a-f0-9-]{36}$/.test(operationId||'')||!actor)throw Error('Invalid switch identity.');
    const c=await config();
    const pending=await json(path.join(c.directory,'request.json'));
    if(c.nodeRole!=='local-server'||pending.shopId!==shopId||pending.id!==operationId||!['use-local','use-cloud'].includes(pending.kind))throw Error('This switch is no longer pending.');
    // Each operation owns a distinct marker. A delayed click cannot stop a newer switch.
    await atomic(path.join(c.directory,'switch-stop-'+operationId+'.json'),{id:operationId,shopId,actor,requestedAt:new Date().toISOString()});
    return {id:operationId,stopRequested:true};
  }
  return {status,request,recoverSwitch};
}
module.exports={createRecoveryControl};
