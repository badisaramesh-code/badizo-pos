const {createCloudSyncSettingsService}=require('./cloudSyncSettingsService');
const {createCloudSyncWorker}=require('./cloudSyncWorker');
const {createOutboxSender}=require('./syncOutbox');

// Explicit composition for enrolled installations; never constructed by default
// startup. The caller owns transport authentication and authority/baseline checks.
function createCloudSyncRuntime({pool,identity,send,canTransfer=async()=>false,configDirectory,clock=()=>Date.now(),batchSize=10}){
  let settings;
  const flush=createOutboxSender({pool,identity,send:async event=>{
    if(await canTransfer()!==true)throw Error('Transfer permission changed.');
    return send(event);
  }});
  const worker=createCloudSyncWorker({pool,identity,flush,canTransfer,getSchedule:()=>settings.loadSchedule(),clock,batchSize});
  settings=createCloudSyncSettingsService({configDirectory,nodeRole:'local-server',getWorkerState:worker.status,requestTransfer:worker.requestNow,clock:()=>new Date(clock())});
  return {settings,worker,start:worker.start,stop:worker.stop};
}
module.exports={createCloudSyncRuntime};
