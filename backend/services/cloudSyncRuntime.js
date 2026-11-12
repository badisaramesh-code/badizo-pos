const {createCloudSyncSettingsService}=require('./cloudSyncSettingsService');
const {createCloudSyncWorker}=require('./cloudSyncWorker');
const {createOutboxSender}=require('./syncOutbox');

// Explicit composition for enrolled installations; never constructed by default
// startup. The caller owns transport authentication and authority/baseline checks.
function createCloudSyncRuntime({pool,identity,send,pull=null,canTransfer=async()=>false,configDirectory,clock=()=>Date.now(),batchSize=10,beforeTransfer=async()=>{},withTransfer=operation=>operation()}){
  let settings;
  const push=createOutboxSender({pool,identity,send:async event=>{
    if(await canTransfer()!==true)throw Error('Transfer permission changed.');
    return send(event);
  }});
  if(pull!==null && typeof pull!=='function')throw Error('Invalid cloud pull adapter.');
  async function flush(options){
    return withTransfer(async()=>{
    await beforeTransfer();
    // Pull first so a stale local product edit cannot starve incoming cloud
    // sales indefinitely. Each direction still requires its own safe handler.
    const incoming=pull?await pull(options):{busy:false,acknowledged:0,hasMore:false};
    if(incoming.busy)return incoming;
    const outgoing=await push(options);
    if(outgoing.busy)return outgoing;
    return {busy:false,acknowledged:incoming.acknowledged+outgoing.acknowledged,hasMore:incoming.hasMore||outgoing.acknowledged===options.limit};
    });
  }
  const worker=createCloudSyncWorker({pool,identity,flush,canTransfer,getSchedule:()=>settings.loadScheduleRecord(),clock,batchSize,
    audit: (status, time, trigger) => require('./transferAudit').appendSyncEvent(configDirectory, status, time, trigger)});
  settings=createCloudSyncSettingsService({configDirectory,nodeRole:'local-server',getWorkerState:async()=>({...await worker.status(),direction:pull?'two-way':'upload'}),requestTransfer:worker.requestNow,clock:()=>new Date(clock())});
  return {settings,worker,flush,start:worker.start,stop:worker.stop};
}
module.exports={createCloudSyncRuntime};
