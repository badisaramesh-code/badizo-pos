import React,{useEffect,useState} from 'react';
import api,{getStoredUser} from '../api/client';
export default function RecoveryControl(){
  const [state,setState]=useState(null),[job,setJob]=useState(null),[pending,setPending]=useState(null),[busy,setBusy]=useState(false),[error,setError]=useState('');
  const [lossAccepted,setLossAccepted]=useState(false);
  const allowed=getStoredUser()?.role==='SERVER';
  useEffect(()=>{
    if(!allowed)return;
    let alive=true;
    async function refresh(){
      try{const {data}=await api.get('/recovery-control');if(alive){setState(data);setError('');}}catch(failure){if(alive&&failure.response?.status!==404)setError('Recovery controls are temporarily unavailable. A restart may be in progress.');}
      try{const {data}=await api.get('/staged-restore');if(alive)setJob(data.job);}catch{}
    }
    refresh();const timer=setInterval(refresh,3000);return()=>{alive=false;clearInterval(timer);};
  },[allowed]);
  if(!allowed||!state)return null;
  const cloud=['cloud-active','cloud-standby'].includes(state.nodeRole);
  const active=state.operation&&!['complete','rolled-back','failed'].includes(state.operation.state);
  const disabled=busy||active||!state.supervisorOnline;
  async function submit(){
    setBusy(true);setError('');
    try{await api.post('/recovery-control',{kind:pending.kind,jobId:pending.kind==='activate-restore'?job.id:undefined,expectedGeneration:state.generation,confirmation:pending.confirmation});setPending(null);setState({...state,operation:{state:'queued'}});}
    catch(failure){setError(failure.response?.data?.error||'Recovery request failed. Refresh before retrying.');setPending(null);}
    finally{setBusy(false);}
  }
  return <section className="panel system-folder-panel"><div className="panel-header green"><h2 className="panel-title">{cloud?'Cloud emergency billing':'Local billing recovery'}</h2></div><div className="panel-body form-stack">
    <p>Local is the main billing server. Cloud is for emergencies. Only one server may be used for billing at a time.</p>
    <p>Billing: <strong>{state.billingMode}</strong> · Recovery: {state.phase} · Supervisor: {state.supervisorOnline?'online':'offline'}</p>
    {state.operation&&<p role="status">Last operation: {state.operation.state}. {state.operation.message}</p>}
    {state.reconciliationRequired&&<p>Reconciliation is required. Resuming local billing does not confirm that cloud changes have been merged.</p>}
    {!cloud&&state.preparation?.canResumeOriginal&&['failed','rolled-back'].includes(state.operation?.state)&&<p role="status">Preparation stopped before switching the local database. You can retry recovery, or use Emergency local billing after confirming every cloud counter has stopped. That cancels this preparation and keeps its files for review.</p>}
    {!cloud&&state.preparation?.pendingPeerCancel&&<p role="status">Local recovery was cancelled, but the cloud hold has not been cleared. Local billing can continue. When internet returns, finish the cancellation below before expecting cloud synchronization to resume.</p>}
    {!cloud&&state.preparation?.state==='prepared-disabled'&&state.operation?.state==='failed'&&!state.preparation?.canResumeOriginal&&<p role="status">Recovery reached pair installation. Resume the prepared recovery or have its state inspected; switching back to an old database is not automatic because a candidate may already have been installed.</p>}
    {!cloud&&state.baseline&&<div className="change-box" role="status"><strong>Reconnect after a backup restore: {state.baseline.state}</strong><span>{state.baseline.mode==='lost-local-copy'?'Copy recovery: use the final verified cloud snapshot. The old local database is retained separately; its missing changes are not merged.':'Verified-copy recovery checks both original databases before reconnecting synchronization.'}</span><span>New local copy: {state.baseline.installed?'installed':'not installed'}. Both nodes are verified before local billing resumes.</span></div>}
    <div className="settings-action-row">
      {!cloud&&state.preparation?.pendingPeerCancel&&<button type="button" disabled={disabled} onClick={()=>setPending({kind:'finish-recovery-cancel',confirmation:'KEEP CLOUD STANDBY AND FINISH CANCEL',message:'Reconnect to cloud and clear only the cancelled recovery hold? Cloud will remain in standby; local billing will not switch databases.'})}>Finish cancelled recovery cleanup</button>}
      {!cloud&&state.preparation?.allowedModes?.includes('verified-copy')&&<button type="button" disabled={disabled} onClick={()=>{setLossAccepted(false);setPending({kind:'prepare-baseline',confirmation:'PREPARE VERIFIED CLOUD COPY AND RETURN LOCAL',message:'Pause both servers, prepare fresh copies of the final cloud snapshot, verify the original local data also matches, reconnect synchronization, and resume local billing. If local contains different or newer records, this stops for reconciliation without replacing the original.'});}}>Rebuild synchronization using verified copies</button>}
      {!cloud&&state.preparation?.allowedModes?.includes('lost-local-copy')&&<button type="button" disabled={disabled} onClick={()=>{setLossAccepted(false);setPending({kind:'prepare-lost-local',confirmation:'LOCAL SOURCE IS UNRECOVERABLE - PREPARE CLOUD COPY AND RETURN LOCAL',loss:true,message:'Recover local billing from cloud after losing the original local database? This pauses both servers, downloads the final cloud snapshot, restores separate verified copies, reconnects synchronization, and starts LOCAL billing only. Any old local database is retained separately. Unsent sales lost with the original local database cannot be recovered.'});}}>Local data lost: recover from cloud</button>}
      {!cloud&&state.baseline?.operationId&&state.baseline.state!=='complete'&&<button type="button" disabled={disabled} onClick={()=>{setLossAccepted(false);setPending(state.baseline.mode==='lost-local-copy'?{kind:'copy-lost-local',confirmation:'LOCAL SOURCE IS UNRECOVERABLE - COPY CLOUD AND RETAIN OLD DATABASE',loss:true,message:'Use this only when the original local data cannot be recovered. Pause both servers, verify the final cloud snapshot, reconnect the prepared copies, and resume LOCAL billing. Sales missing from both cloud and the backup cannot be recovered. Any existing local database is retained separately; this does not merge its changes.'}:{kind:'reconnect-baseline',confirmation:'RECONNECT VERIFIED COPIES',message:'Pause both servers, verify the prepared snapshot against both originals, reconnect the new synchronization baseline, then resume local billing only. If either original contains newer or different data, recovery stops without replacing it.'});}}> {state.baseline.mode==='lost-local-copy'?'Copy verified cloud data and reconnect local':'Reconnect verified local and cloud copies'} </button>}
      {!cloud&&state.handoffAvailable&&<><button type="button" disabled={disabled} onClick={()=>setPending({kind:'use-cloud',confirmation:'SYNC AND USE CLOUD',message:'Pause billing on both servers, synchronize pending changes, and then enable cloud billing? Both servers must be reachable.'})}>Sync and use cloud</button><button type="button" disabled={disabled} onClick={()=>setPending({kind:'use-local',confirmation:'SYNC AND USE LOCAL',message:'Pause both servers, bring cloud sales back, and then resume local billing? If synchronization cannot finish, activation will not proceed.'})}>Sync and return to local</button></>}
      <button type="button" disabled={disabled} onClick={()=>setPending({kind:'standby',confirmation:'PAUSE BILLING',message:'Pause new billing writes and wait for current requests to finish?'})}>Pause billing on this server</button>
      {cloud ? <button type="button" disabled={disabled} onClick={()=>setPending({kind:'emergency-cloud',confirmation:'LOCAL BILLING IS STOPPED - USE CLOUD',message:'Continue billing using cloud data? Confirm that all local counters have stopped billing. Changes newer than the last successful sync may be missing here.'})}>Use cloud emergency billing</button> : <button type="button" disabled={disabled} onClick={()=>setPending({kind:'emergency-local',confirmation:'CLOUD BILLING IS STOPPED - USE LOCAL',message:'Use this only after ALL cloud counters have stopped billing. If cloud is unreachable, the software cannot verify that for you. This starts local billing without confirming that cloud sales have been received. Use Sync and return to local whenever both servers are reachable.'})}>Emergency local billing</button>}
      {!cloud && <button type="button" disabled={disabled||job?.state!=='verified'} onClick={()=>setPending({kind:'activate-restore',confirmation:'USE VERIFIED RESTORE',message:`Switch local billing to the verified restore containing ${job.result.invoices} invoices? The current database will be retained separately. Its newer records will not be merged by this action.`})}>Use verified restore for local billing</button>}
    </div>
    {pending&&<div role="alert"><p>{pending.message}</p>{pending.loss&&<label><input type="checkbox" checked={lossAccepted} onChange={event=>setLossAccepted(event.target.checked)} /> I confirm the original local source is unrecoverable and understand that unsent local sales may be missing.</label>}<button type="button" disabled={busy||(pending.loss&&!lossAccepted)} onClick={submit}>Confirm</button><button type="button" disabled={busy} onClick={()=>setPending(null)}>Cancel</button></div>}
    {error&&<p role="alert">{error}</p>}
  </div></section>;
}
