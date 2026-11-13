'use strict';
const fs=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto');
const {coordinate,compareCoordinates}=require('./nativeReplicaControl');
async function writeReplicaStatus(file,value){
  const temporary=file+'.'+crypto.randomUUID()+'.tmp';await fs.mkdir(path.dirname(file),{recursive:true,mode:0o700});
  try{await fs.writeFile(temporary,JSON.stringify(value),{flag:'wx',mode:0o600});await fs.rename(temporary,file);}finally{await fs.unlink(temporary).catch(()=>{});}
}
function dailySlot(config,now){
  if(config.frequency!=='daily'||config.timezone!=='Asia/Kolkata'||!/^([01]\d|2[0-3]):[0-5]\d$/.test(config.dailyTime||''))throw Error('Native delta sync requires a valid daily India-time schedule.');
  const local=new Date(now+330*60000),day=local.toISOString().slice(0,10),at=local.toISOString().slice(11,16);
  return {day,due:at>=config.dailyTime};
}
function nextDailyAt(config,now){const slot=dailySlot(config,now);const [h,m]=config.dailyTime.split(':').map(Number);const day=Date.parse(slot.day+'T00:00:00Z');let next=day+(h*60+m)*60000-330*60000;if(next<=now)next+=86400000;return new Date(next).toISOString();}
function createNativeReplicaAgent({control,loadSchedule,writeStatus,verifyAuthority,readState,saveState,getSourceCheckpoint,
  readManual=async()=>null,clearManual=async()=>{},audit=async()=>{},baselineId,clock=()=>Date.now(),maxRunMs=1800000}){
  if(!/^[a-f0-9]{64}$/.test(baselineId||'')||![verifyAuthority,readState,saveState,getSourceCheckpoint].every(fn=>typeof fn==='function'))throw Error('Durable state, verified authority and source checkpoint adapters are required.');
  let busy=false;
  async function tick(){
    if(busy)return {busy:true};busy=true;let state;
    try{
      state=await readState()||{schemaVersion:1,baselineId,activeJob:null,lastCompletedDay:null,lastSuccessAt:null};
      if(state.schemaVersion!==1||state.baselineId!==baselineId)throw Error('Saved sync state belongs to a different verified baseline.');
      if(state.activeJob){coordinate(state.activeJob.target);if(!state.activeJob.id||!Number.isFinite(Date.parse(state.activeJob.startedAt)))throw Error('Invalid pending daily sync job.');}
      let authority=false;try{authority=await verifyAuthority()===true;}catch{}
      if(!authority){await control.pause();throw Error('Local or cloud authority changed. Replication stays paused until the baseline is reverified.');}
      const schedule=await loadSchedule(),slot=dailySlot(schedule.config,clock()),manual=await readManual();
      const held=schedule.transfersPaused===true||(!schedule.config.enabled&&!manual&&!state.activeJob?.manualId);
      if(held){const replica=await control.pause();return publish({...replica,state:'paused',manualPending:!!manual},state,schedule);}
      if(!state.activeJob){
        const due=schedule.config.enabled&&slot.due&&(!state.lastCompletedDay||state.lastCompletedDay<slot.day);
        if(!due&&!manual){const replica=await control.pause();return publish({...replica,state:'idle',manualPending:false},state,schedule);}
        await control.pause();
        const target=coordinate(await getSourceCheckpoint());
        state.activeJob={id:crypto.randomUUID(),target:{file:target.file,position:target.position},slot:due?slot.day:null,manualId:manual?.id||null,startedAt:new Date(clock()).toISOString(),attemptAt:new Date(clock()).toISOString()};
        // Persist the exact committed source endpoint BEFORE any replica START command.
        await saveState(state);
        try{await audit('Started',state.activeJob);}catch{ /* Optional transfer history never controls checkpoint safety. */ }
        if(manual)await clearManual(manual.id);
      }
      const job=state.activeJob;
      if(clock()-Date.parse(job.attemptAt||job.startedAt)>maxRunMs){
        await control.pause();job.attemptAt=new Date(clock()).toISOString();await saveState(state);
        throw Error('Daily catch-up exceeded its time budget and was paused. The same target is retained for retry.');
      }
      let replica=await control.inspect();
      if(compareCoordinates(replica.applied,job.target)<0)replica=await control.startUntil(job.target);
      if(compareCoordinates(replica.applied,job.target)>0)throw Error('Cloud applied beyond the managed daily target; no completion was recorded.');
      if(compareCoordinates(replica.applied,job.target)===0){
        replica=await control.pause();
        if(compareCoordinates(replica.applied,job.target)!==0)throw Error('Exact target checkpoint is not confirmed after stopping.');
        const completed={...job,applied:replica.applied,completedAt:new Date(clock()).toISOString()};
        state.lastSuccessAt=completed.completedAt;state.lastCompletedJob=completed;
        if(job.slot)state.lastCompletedDay=job.slot;
        state.activeJob=null;await saveState(state);
        try{await audit('Completed',completed);}catch{ /* The applied checkpoint is already durably confirmed. */ }
        if(job.manualId)await clearManual(job.manualId);
        return publish({...replica,state:'idle',manualPending:false},state,schedule);
      }
      if(replica.sqlError||replica.ioError===1236){await control.pause();throw Error('A missing log or SQL apply error needs inspection. No transaction was skipped.');}
      return publish({...replica,state:replica.receiver==='Connecting'?'retrying':'running',manualPending:false},state,schedule);
    }catch(error){
      try{await control.pause();}catch{} // Never leave an untracked/unverified applier running if it can be fenced safely.
      const result={engine:'mysql-replication',ready:false,state:'blocked',reason:error.code==='NATIVE_MAINTENANCE_BUSY'?'Cloud maintenance is active.':error.code?'Replication connection is unavailable.':error.message,
        lastSuccessAt:state?.lastSuccessAt||null,activeTarget:state?.activeJob?.target||null,heartbeatAt:new Date(clock()).toISOString(),nextRunAt:null};
      await writeStatus(result);return result;
    }finally{busy=false;}
  }
  async function publish(fields,state,schedule){
    const result={...fields,engine:'mysql-replication',frequency:'daily',lastSuccessAt:state.lastSuccessAt,
      activeTarget:state.activeJob?.target||null,lastCompletedTarget:state.lastCompletedJob?.target||null,
      nextRunAt:schedule.config.enabled&&!schedule.transfersPaused?nextDailyAt(schedule.config,clock()):null,heartbeatAt:new Date(clock()).toISOString()};
    await writeStatus(result);return result;
  }
  return {tick};
}
module.exports={createNativeReplicaAgent,writeReplicaStatus,dailySlot,nextDailyAt};
