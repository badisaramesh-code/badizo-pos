'use strict';
const fs=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto'),os=require('node:os');
const {createCloudSyncSettingsService}=require('./cloudSyncSettingsService');
async function optionalJson(file){try{return JSON.parse(await fs.readFile(file,'utf8'));}catch(error){if(error.code==='ENOENT')return null;throw error;}}
async function invalidated(directory){try{await fs.lstat(path.join(directory,'native-invalidation.json'));return true;}catch(error){if(error.code==='ENOENT')return false;throw error;}}
async function queueManual(directory,user,clock){
  await fs.mkdir(directory,{recursive:true,mode:0o700});
  const file=path.join(directory,'native-manual.json'),temporary=file+'.'+crypto.randomUUID()+'.tmp';
  const request={id:crypto.randomUUID(),requestedAt:clock().toISOString(),actor:String(user?.username||'server').slice(0,100)};
  try{await fs.writeFile(temporary,JSON.stringify(request),{flag:'wx',mode:0o600});try{await fs.link(temporary,file);}catch(error){if(error.code!=='EEXIST')throw error;}}
  finally{await fs.unlink(temporary).catch(()=>{});}
}
function createNativeReplicaSettings({directory,nodeRole='local-server',clock=()=>new Date()}){
  if(!path.isAbsolute(directory||'')||nodeRole!=='local-server')throw Error('Native daily sync requires a protected local-server directory.');
  async function worker(){
    try{
      if(await invalidated(directory))return {ready:false,state:'blocked',reason:'Backup recovery changed this sync baseline. A newly verified baseline is required.',nextRunAt:null};
      const raw=await optionalJson(path.join(directory,'native-status.json')),age=clock().getTime()-Date.parse(raw?.heartbeatAt);
      if(raw?.engine!=='mysql-replication'||!Number.isFinite(age)||age < -5000||age>20000)throw Error('Stale status');
      const manual=await optionalJson(path.join(directory,'native-manual.json'));
      const cleanPoint=point=>point&&/^[A-Za-z0-9_-]+\.\d{6}$/.test(point.file)&&Number.isSafeInteger(point.position)&&point.position>=4?{file:point.file,position:point.position}:null;
      return {ready:raw.ready===true,state:raw.state,lastSuccessAt:raw.lastSuccessAt||null,nextRunAt:raw.nextRunAt||null,
        reason:raw.ready?null:raw.reason||'Daily replication requires inspection.',manualPending:!!manual,
        lagSeconds:raw.lagSeconds??null,received:cleanPoint(raw.received),applied:cleanPoint(raw.applied),
        activeTarget:cleanPoint(raw.activeTarget),lastCompletedTarget:cleanPoint(raw.lastCompletedTarget)};
    }catch{return {ready:false,state:'not-configured',reason:'The daily replication agent is not configured or its heartbeat is stale.',nextRunAt:null};}
  }
  const base=createCloudSyncSettingsService({configDirectory:directory,nodeRole,clock,getWorkerState:worker,requestTransfer:user=>queueManual(directory,user,clock)});
  async function state(){
    const value=await base.state(),health=await worker();
    return {...value,service:{...value.service,engine:'mysql-replication',state:health.state,direction:'upload'},
      received:health.received,applied:health.applied,activeTarget:health.activeTarget,lastCompletedTarget:health.lastCompletedTarget,lagSeconds:health.lagSeconds,
      message:!health.ready?health.reason:value.transfersPaused?(health.state==='paused'?'Daily cloud sync is paused. Local billing continues; the unfinished target is retained.':'Pause requested; waiting for the agent to confirm that replica threads have stopped.'):
        value.config.enabled?'Daily cloud sync copies changes through a verified source checkpoint, then stops. Local billing continues.':'Automatic daily sync is disabled. Local billing continues.'};
  }
  async function save(input,user){
    if(user?.role==='SERVER'&&input?.frequency!=='daily')throw Object.assign(Error('Native delta sync uses the daily schedule.'),{status:400});
    await base.save(input,user);return state();
  }
  return {state,save,audit:base.audit,setPaused:async(paused,user)=>{await base.setPaused(paused,user);return state();},
    requestNow:async user=>{await base.requestNow(user);return state();}};
}
function configuredCloudSyncService(){
  const directory=process.env.BADIZO_NATIVE_REPLICATION_DIR;
  if(!directory)return createCloudSyncSettingsService();
  try{
    if(process.env.BADIZO_SYNC_ENROLLMENT_CONFIG)throw Error('Native and application-event appliers cannot run together.');
    const legacy=process.env.BADIZO_CLOUD_SYNC_CONFIG_DIR||path.join(os.homedir(),'BadizoCloudSync');
    if(path.resolve(directory).toLowerCase()===path.resolve(legacy).toLowerCase())throw Error('Native sync requires a separate control directory.');
    return createNativeReplicaSettings({directory,nodeRole:process.env.BADIZO_NODE_ROLE||'local-server'});
  }catch(error){
    // Optional replication misconfiguration must not prevent local billing startup.
    const state=async()=>({config:{enabled:false,frequency:'daily',dailyTime:'20:30',timezone:'Asia/Kolkata'},editable:false,nodeRole:process.env.BADIZO_NODE_ROLE||'local-server',service:{engine:'mysql-replication',ready:false,state:'not-configured',direction:'upload'},transfersPaused:true,lastSuccessAt:null,nextRunAt:null,message:error.message});
    const blocked=async()=>{throw Object.assign(Error('Native sync configuration needs inspection; local billing can continue.'),{status:409});};
    return {state,save:blocked,setPaused:blocked,requestNow:blocked,audit:async()=>({rows:[],warnings:['Native sync configuration needs inspection.']})};
  }
}
module.exports={createNativeReplicaSettings,configuredCloudSyncService,optionalJson,invalidated};
