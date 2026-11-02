import React,{useEffect,useState} from 'react';
import api,{getStoredUser} from '../api/client';
export default function RecoveryControl(){
  const [state,setState]=useState(null),[job,setJob]=useState(null),[pending,setPending]=useState(null),[busy,setBusy]=useState(false),[error,setError]=useState('');
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
    <p>Billing: <strong>{state.billingMode}</strong> · Recovery: {state.phase} · Supervisor: {state.supervisorOnline?'online':'offline'}</p>
    {state.operation&&<p role="status">Last operation: {state.operation.state}. {state.operation.message}</p>}
    {state.reconciliationRequired&&<p>Reconciliation is required. Resuming local billing does not confirm that cloud changes have been merged.</p>}
    <div className="settings-action-row">
      <button type="button" disabled={disabled} onClick={()=>setPending({kind:'standby',confirmation:'PAUSE BILLING',message:'Pause new billing writes and wait for current requests to finish?'})}>Pause billing on this server</button>
      {cloud ? <button type="button" disabled={disabled} onClick={()=>setPending({kind:'emergency-cloud',confirmation:'LOCAL BILLING IS STOPPED - USE CLOUD',message:'Continue billing using cloud data? Confirm that all local counters have stopped billing. Changes newer than the last successful sync may be missing here.'})}>Use cloud emergency billing</button> : <button type="button" disabled={disabled} onClick={()=>setPending({kind:'emergency-local',confirmation:'START LOCAL AND RECONCILE LATER',message:'Start billing on this local database? Cloud may still contain separate changes. Stop using cloud counters and reconcile before treating both databases as synchronized.'})}>Emergency local billing</button>}
      {!cloud && <button type="button" disabled={disabled||job?.state!=='verified'} onClick={()=>setPending({kind:'activate-restore',confirmation:'USE VERIFIED RESTORE',message:`Switch local billing to the verified restore containing ${job.result.invoices} invoices? The current database will be retained separately. Its newer records will not be merged by this action.`})}>Use verified restore for local billing</button>}
    </div>
    {pending&&<div role="alert"><p>{pending.message}</p><button type="button" disabled={busy} onClick={submit}>Confirm</button><button type="button" disabled={busy} onClick={()=>setPending(null)}>Cancel</button></div>}
    {error&&<p role="alert">{error}</p>}
  </div></section>;
}
