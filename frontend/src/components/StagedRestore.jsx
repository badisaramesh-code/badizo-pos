import React,{useEffect,useState} from 'react';
import api,{getStoredUser} from '../api/client';
export default function StagedRestore(){
  const [status,setStatus]=useState(null),[error,setError]=useState(''),[confirm,setConfirm]=useState(false),[busy,setBusy]=useState(false);
  const allowed=getStoredUser()?.role==='SERVER';
  useEffect(()=>{
    if(!allowed)return;
    let live=true;
    async function refresh(){try{const {data}=await api.get('/staged-restore');if(live){setStatus(data);setError('');}}catch(failure){if(live && failure.response?.status!==404)setError('Unable to read recovery status. Check with the installer before starting another restore.');}}
    refresh();const timer=setInterval(refresh,5000);return()=>{live=false;clearInterval(timer);};
  },[allowed]);
  if(!allowed || (!status && !error))return null;
  async function start(){setBusy(true);setError('');try{const {data}=await api.post('/staged-restore',{confirmation:'RESTORE TO SEPARATE DATABASE'});setStatus({configured:true,job:data});setConfirm(false);}catch(failure){setError(failure.response?.data?.error || 'Could not start restore.');}finally{setBusy(false);}}
  const job=status?.job;
  return <section className="panel system-folder-panel"><div className="panel-header green"><h2 className="panel-title">Prepare local recovery</h2></div><div className="panel-body form-stack">
    <p>Restore the backup selected by your installer into a separate recovery database. Your active database and billing mode will not be switched.</p>
    {job && <div role="status"><p>Restore status: <strong>{job.state}</strong></p><p>Started by {job.actor} at {job.startedAt}</p>{job.state==='running' && <p>Keep this server running. After an unexpected restart, the installer must inspect the job before retrying.</p>}{job.result && <p>Verified {job.result.tableCount} tables, {job.result.products} products and {job.result.invoices} invoices. Billing activation still requires verification and setup.</p>}{job.message && <p>{job.message}</p>}</div>}
    {!confirm ? <button type="button" disabled={busy || !status || !!job} onClick={()=>setConfirm(true)}>Prepare restore from configured backup</button> : <div role="alert"><p>Start a restore into the separately configured empty database? This can take several minutes.</p><button type="button" disabled={busy} onClick={start}>Start staged restore</button><button type="button" disabled={busy} onClick={()=>setConfirm(false)}>Cancel</button></div>}
    {error && <p role="alert">{error}</p>}
  </div></section>;
}
