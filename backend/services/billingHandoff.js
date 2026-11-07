// Durable orchestration belongs to the recovery supervisor, not an HTTP
// request. Adapters must enforce the same operation ID and enrolled baseline.
async function executeBillingHandoff({id,target,local,cloud,transfer,record,checkpoint=async()=>{},maxBatches=10000,maxBusyChecks=50,wait=()=>new Promise(resolve=>setTimeout(resolve,100))}){
  if(!/^[a-f0-9-]{36}$/.test(id)||!['local','cloud'].includes(target))throw Error('Invalid handoff identity.');
  const paused=state=>state.handoffId===id&&state.billingMode==='standby'&&state.phase==='active'&&state.activeWrites===0;
  const held=state=>state.handoffId===id&&state.billingMode==='standby'&&state.phase==='active';
  let busyChecks=0;
  await checkpoint();await record('pausing-local');await local.pause(id);
  await checkpoint();await record('pausing-cloud');await cloud.pause(id);
  await record('synchronizing');
  for(let batch=0;batch<maxBatches;batch++){
    await checkpoint();
    const a=await local.status(),b=await cloud.status();
    if(!held(a)||!held(b))throw Error('Both enrolled servers must remain paused for handoff.');
    // An already admitted sync request can still be finishing its response.
    // Wait for that lease to drain while continuously checking the hold;
    // never mistake a busy response for permission to activate billing.
    if(!paused(a)||!paused(b)){
      if(++busyChecks>maxBusyChecks)throw Error('Handoff write leases did not drain.');
      await wait();continue;
    }
    if(a.pending===0&&b.pending===0){
      await checkpoint();
      await record('activating-'+target);
      // The inactive node remains fenced. A lost activation reply must never
      // cause the other node to be enabled as an automatic rollback.
      await (target==='local'?local:cloud).activate(id);
      const [finalLocal,finalCloud]=await Promise.all([local.status(),cloud.status()]);
      const active=target==='local'?finalLocal:finalCloud,standby=target==='local'?finalCloud:finalLocal;
      if(active.handoffId!==id||active.billingMode!=='active'||active.phase!=='active'||!paused(standby))throw Error('Activation outcome requires inspection; do not enable the other server.');
      await record('complete');return {target,complete:true};
    }
    await checkpoint();
    const result=await transfer(id);
    if(result.failed)throw Error('Synchronization is busy or blocked; billing remains paused.');
    if(result.busy){if(++busyChecks>maxBusyChecks)throw Error('Handoff write leases did not drain.');await wait();}
  }
  throw Error('Handoff backlog exceeds this run limit; retry from retained state.');
}
module.exports={executeBillingHandoff};
