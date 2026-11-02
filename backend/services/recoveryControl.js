const fs=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto');
const {json}=require('./recoveryControlFiles');
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
      if(pending.id!==operation?.id)operation={id:pending.id,kind:pending.kind,actor:pending.actor,state:'queued'};
    }catch(error){if(error.code!=='ENOENT')throw error;}
    try{heartbeat=await json(path.join(c.directory,'heartbeat.json'));}catch(error){if(error.code!=='ENOENT')throw error;}
    return {configured:true,nodeRole:c.nodeRole,handoffAvailable:!!c.enrollmentConfigPath&&c.nodeRole==='local-server',handoffId:binding.handoffId||null,supervisorOnline:heartbeat?.shopId===shopId&&Date.now()-Date.parse(heartbeat.at)<15000,generation:binding.generation,phase:binding.phase,billingMode:binding.billingMode,reconciliationRequired:!!binding.reconciliationRequired,operation};
  }
  async function request({kind,jobId,handoffId,expectedGeneration,actor}){
    if(!['activate-restore','standby','emergency-local','emergency-cloud','use-cloud','use-local','handoff-standby','handoff-active'].includes(kind)||!Number.isSafeInteger(expectedGeneration)||typeof actor!=='string'||!actor.trim())throw Error('Invalid recovery operation.');
    if(kind.startsWith('handoff-')&&!/^[a-f0-9-]{36}$/.test(handoffId||''))throw Error('Handoff identity required.');
    if(kind==='activate-restore'&&!/^[a-f0-9-]{36}$/.test(jobId||''))throw Error('A verified restore job is required.');
    const c=await config(),state=await status();
    if(!state.supervisorOnline||state.generation!==expectedGeneration)throw Error('Supervisor unavailable or state changed.');
    if(state.phase!=='active')throw Error('An unfinished activation requires inspection before another operation.');
    if(['use-cloud','use-local'].includes(kind)&&(!c.enrollmentConfigPath||c.nodeRole!=='local-server'))throw Error('Coordinated handoff must start on the enrolled local supervisor.');
    if(kind==='emergency-cloud'&&!['cloud-active','cloud-standby'].includes(c.nodeRole))throw Error('Cloud emergency billing is cloud only.');
    if(kind==='activate-restore'&&c.nodeRole!=='local-server')throw Error('Restore activation is local only.');
    if(kind==='emergency-local'&&c.nodeRole!=='local-server')throw Error('Emergency local billing is only available locally.');
    if(state.operation&&!['complete','rolled-back','failed'].includes(state.operation.state))throw Error('A recovery operation is already pending.');
    const value={id:crypto.randomUUID(),shopId,kind,jobId:jobId||null,handoffId:handoffId||null,expectedGeneration,actor,requestedAt:new Date().toISOString()};
    const file=await fs.open(path.join(c.directory,'request.json'),'wx',0o600);
    try{await file.writeFile(JSON.stringify(value));await file.sync();}finally{await file.close();}
    return {id:value.id,state:'queued'};
  }
  return {status,request};
}
module.exports={createRecoveryControl};
