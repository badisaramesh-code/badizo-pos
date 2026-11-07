import React,{useEffect,useRef,useState} from 'react';
import api,{getStoredUser} from '../api/client';
export default function RecoveryControl(){
  const [state,setState]=useState(null),[job,setJob]=useState(null),[pending,setPending]=useState(null),[busy,setBusy]=useState(false),[error,setError]=useState('');
  const [lossAccepted,setLossAccepted]=useState(false);
  const [statusError, setStatusError] = useState('');
  const [fresh, setFresh] = useState(false);
  const [syncGap, setSyncGap] = useState(false);
  const refreshRef = useRef(null);
  const allowed = getStoredUser()?.role === 'SERVER';
  useEffect(() => {
    if (!allowed) return;
    let alive = true, sequence = 0, timer, readinessTimer;
    async function refresh() {
      clearTimeout(timer);
      const current = ++sequence;
      const options = { timeout: 5000, __badizoNoRetry: true };
      const [control, restore] = await Promise.allSettled([
        api.get('/recovery-control', options), api.get('/staged-restore', options)
      ]);
      if (!alive || current !== sequence) return;
      setJob(restore.status === 'fulfilled' ? restore.value.data.job : null);
      if (control.status === 'fulfilled') {
        setState(control.value.data);
        setFresh(true);
        setStatusError('');
      } else {
        setFresh(false);
        setPending(null);
        if (control.reason.response?.status === 404) setState(null);
        setStatusError(control.reason.response?.status === 404 ? '' :
          'Current server status is unavailable. Wait for it to reconnect before choosing a recovery action.');
      }
      timer = setTimeout(refresh, 3000);
    }
    async function readSyncStatus() {
      try {
        const { data } = await api.get('/ready', { timeout: 5000, __badizoNoRetry: true });
        if (alive) setSyncGap(data.sync?.reason === 'capture-gap-requires-baseline');
      } catch { /* Keep the last reported gap until the server confirms it cleared. */ }
      if (alive) readinessTimer = setTimeout(readSyncStatus, 60000);
    }
    refreshRef.current = refresh;
    refresh();
    readSyncStatus();
    return () => { alive = false; clearTimeout(timer); clearTimeout(readinessTimer); refreshRef.current = null; };
  }, [allowed]);
  if (!allowed) return null;
  const gapWarning = syncGap && <p role="alert">Local billing can continue. Cloud updates are paused because some local changes may be missing from sync. Rebuild synchronization before relying on cloud billing.</p>;
  if (!state) return <>{gapWarning}{statusError && <p role="alert">{statusError}</p>}</>;
  const cloud=['cloud-active','cloud-standby'].includes(state.nodeRole);
  const operation = state.operation;
  const active = operation && !['complete','rolled-back','failed'].includes(operation.state);
  const disabled = busy || active || !fresh || !state.supervisorOnline;
  const canStop = state.nodeRole === 'local-server' && active && ['use-cloud','use-local'].includes(operation.kind) &&
    operation.id && operation.state !== 'finalizing' && !operation.stopRequested;
  const stopPending = pending?.kind === 'recover-switch';
  function selectAction(action) {
    setError('');
    setPending({ ...action, generation: state.generation, jobId: job?.id, operationId: operation?.id });
  }
  const selectionChanged = pending && (pending.generation !== state.generation ||
    (stopPending && (!canStop || pending.operationId !== operation?.id)) ||
    (pending.kind === 'activate-restore' && (pending.jobId !== job?.id || job?.state !== 'verified')));
  const confirmDisabled = busy || !fresh || !state.supervisorOnline || selectionChanged ||
    (!stopPending && disabled) || (pending?.loss && !lossAccepted);
  const target = operation?.kind === 'use-cloud' ? 'Cloud' : operation?.kind === 'use-local' ? 'Local' : null;
  const stages = {queued:'Switch queued', preparing:'Preparing to switch', 'pausing-local':'Waiting for local billing to finish', 'pausing-cloud':'Waiting for cloud billing to finish', synchronizing:'Transferring pending changes', 'activating-cloud':'Activating and checking cloud billing', 'activating-local':'Activating and checking local billing', finalizing:'Finishing the switch'};
  async function submit(){
    if (confirmDisabled) return;
    setBusy(true);
    setError('');
    try {
      if (stopPending) {
        await api.post('/recovery-control/recover-switch', {
          operationId: pending.operationId, confirmation: pending.confirmation
        });
      } else {
        await api.post('/recovery-control', {
          kind: pending.kind, jobId: pending.kind === 'activate-restore' ? pending.jobId : undefined,
          expectedGeneration: pending.generation, confirmation: pending.confirmation
        });
      }
    } catch (failure) {
      setError(failure.response?.data?.error || 'The request could not be confirmed. Check the updated status before retrying.');
    } finally {
      setPending(null);
      setFresh(false);
      await refreshRef.current?.();
      setBusy(false);
    }
  }
  return <section className="panel system-folder-panel"><div className="panel-header green"><h2 className="panel-title">{cloud?'Cloud emergency billing':'Local billing recovery'}</h2></div><div className="panel-body form-stack">
    <p>Local is the main billing server. Cloud is for emergencies. Only one server may be used for billing at a time.</p>
    {gapWarning}
    {statusError && <p role="alert">{statusError}</p>}
    <p>{fresh ? 'Billing' : 'Last reported billing'}: <strong>{state.billingMode}</strong> Â· Recovery: {state.phase} Â· Supervisor: {state.supervisorOnline?'online':'offline'}</p>
     {target && fresh && !error && <div role="status">{active && <progress aria-label="Billing switch in progress" />} {stages[operation.state] || (operation.state === 'complete' ? 'Last confirmed switch: '+target+' billing was activated. Check the active status on that server before billing.' : 'Switch not confirmed. Check both servers before billing.')}</div>}
    {state.operation&&<p role="status">Last operation: {state.operation.state}. {state.operation.message}</p>}
    {state.reconciliationRequired&&<p>Reconciliation is required. Resuming local billing does not confirm that cloud changes have been merged.</p>}
    {!cloud&&state.preparation?.canResumeOriginal&&['failed','rolled-back'].includes(state.operation?.state)&&<p role="status">Preparation stopped before switching the local database. You can retry recovery, or use Emergency local billing after confirming every cloud counter has stopped. That cancels this preparation and keeps its files for review.</p>}
    {!cloud&&state.preparation?.pendingPeerCancel&&<p role="status">Local recovery was cancelled, but the cloud hold has not been cleared. Local billing can continue. When internet returns, finish the cancellation below before expecting cloud synchronization to resume.</p>}
    {!cloud&&state.preparation?.state==='prepared-disabled'&&state.operation?.state==='failed'&&!state.preparation?.canResumeOriginal&&<p role="status">Recovery reached pair installation. Resume the prepared recovery or have its state inspected; switching back to an old database is not automatic because a candidate may already have been installed.</p>}
    {!cloud&&state.baseline&&<div className="change-box" role="status"><strong>Reconnect after a backup restore: {state.baseline.state}</strong><span>{state.baseline.mode==='lost-local-copy'?'Copy recovery: use the final verified cloud snapshot. The old local database is retained separately; its missing changes are not merged.':'Verified-copy recovery checks both original databases before reconnecting synchronization.'}</span><span>New local copy: {state.baseline.installed?'installed':'not installed'}. Both nodes are verified before local billing resumes.</span></div>}
    {operation?.stopRequested && active && <p role="status">Stop requested. Wait for the switch to finish stopping before selecting a billing server.</p>}
    {['owner-stopped', 'activation-unconfirmed'].includes(operation?.failureCode) && <p role="status">
      Last observed billing modes: local {operation.observedModes?.local || 'unknown'}, cloud {operation.observedModes?.cloud || 'unknown'}.
      Check both servers. To resume emergency billing, first stop all counters on the other server, then use the emergency billing button on the server you choose.
    </p>}
    <div className="settings-action-row">
      {canStop && <button type="button" disabled={busy || !fresh || !state.supervisorOnline} onClick={() => selectAction({
        kind: 'recover-switch', confirmation: 'STOP INTERRUPTED SWITCH',
        message: 'Request the interrupted switch to stop? Wait for its final status, then check which server is active before resuming sales.'
      })}>Recover interrupted switch</button>}
      {!cloud&&state.preparation?.pendingPeerCancel&&<button type="button" disabled={disabled} onClick={()=>selectAction({kind:'finish-recovery-cancel',confirmation:'KEEP CLOUD STANDBY AND FINISH CANCEL',message:'Reconnect to cloud and clear only the cancelled recovery hold? Cloud will remain in standby; local billing will not switch databases.'})}>Finish cancelled recovery cleanup</button>}
      {!cloud&&state.preparation?.allowedModes?.includes('verified-copy')&&<button type="button" disabled={disabled} onClick={()=>{setLossAccepted(false);selectAction({kind:'prepare-baseline',confirmation:'PREPARE VERIFIED CLOUD COPY AND RETURN LOCAL',message:'Pause both servers, prepare fresh copies of the final cloud snapshot, verify the original local data also matches, reconnect synchronization, and resume local billing. If local contains different or newer records, this stops for reconciliation without replacing the original.'});}}>Rebuild synchronization using verified copies</button>}
      {!cloud&&state.preparation?.allowedModes?.includes('lost-local-copy')&&<button type="button" disabled={disabled} onClick={()=>{setLossAccepted(false);selectAction({kind:'prepare-lost-local',confirmation:'LOCAL SOURCE IS UNRECOVERABLE - PREPARE CLOUD COPY AND RETURN LOCAL',loss:true,message:'Recover local billing from cloud after losing the original local database? This pauses both servers, downloads the final cloud snapshot, restores separate verified copies, reconnects synchronization, and starts LOCAL billing only. Any old local database is retained separately. Unsent sales lost with the original local database cannot be recovered.'});}}>Local data lost: recover from cloud</button>}
      {!cloud&&state.baseline?.operationId&&state.baseline.state!=='complete'&&<button type="button" disabled={disabled} onClick={()=>{setLossAccepted(false);selectAction(state.baseline.mode==='lost-local-copy'?{kind:'copy-lost-local',confirmation:'LOCAL SOURCE IS UNRECOVERABLE - COPY CLOUD AND RETAIN OLD DATABASE',loss:true,message:'Use this only when the original local data cannot be recovered. Pause both servers, verify the final cloud snapshot, reconnect the prepared copies, and resume LOCAL billing. Sales missing from both cloud and the backup cannot be recovered. Any existing local database is retained separately; this does not merge its changes.'}:{kind:'reconnect-baseline',confirmation:'RECONNECT VERIFIED COPIES',message:'Pause both servers, verify the prepared snapshot against both originals, reconnect the new synchronization baseline, then resume local billing only. If either original contains newer or different data, recovery stops without replacing it.'});}}> {state.baseline.mode==='lost-local-copy'?'Copy verified cloud data and reconnect local':'Reconnect verified local and cloud copies'} </button>}
      {!cloud&&state.handoffAvailable&&<><button type="button" disabled={disabled} onClick={()=>selectAction({kind:'use-cloud',confirmation:'SYNC AND USE CLOUD',message:'Pause billing on both servers, synchronize pending changes, and then enable cloud billing? Both servers must be reachable.'})}>Sync and use cloud</button><button type="button" disabled={disabled} onClick={()=>selectAction({kind:'use-local',confirmation:'SYNC AND USE LOCAL',message:'Pause both servers, bring cloud sales back, and then resume local billing? If synchronization cannot finish, activation will not proceed.'})}>Sync and return to local</button></>}
      <button type="button" disabled={disabled} onClick={()=>selectAction({kind:'standby',confirmation:'PAUSE BILLING',message:'Pause new billing writes and wait for current requests to finish?'})}>Pause billing on this server</button>
      {cloud ? <button type="button" disabled={disabled} onClick={()=>selectAction({kind:'emergency-cloud',confirmation:'LOCAL BILLING IS STOPPED - USE CLOUD',message:'Is the local server still working? Cancel and choose “Sync and use cloud” in System on the LOCAL server to send pending changes first. If local is unavailable, confirm every local counter has stopped. Emergency activation uses the data already on cloud; newer local sales may be missing.'})}>Use cloud emergency billing</button> : <button type="button" disabled={disabled} onClick={()=>selectAction({kind:'emergency-local',confirmation:'CLOUD BILLING IS STOPPED - USE LOCAL',message:'Use this only after ALL cloud counters have stopped billing. If cloud is unreachable, the software cannot verify that for you. This starts local billing without confirming that cloud sales have been received. Use Sync and return to local whenever both servers are reachable.'})}>Emergency local billing</button>}
      {!cloud && <button type="button" disabled={disabled||job?.state!=='verified'} onClick={()=>selectAction({kind:'activate-restore',confirmation:'USE VERIFIED RESTORE',message:`Switch local billing to the verified restore containing ${job.result.invoices} invoices? The current database will be retained separately. Its newer records will not be merged by this action.`})}>Use verified restore for local billing</button>}
    </div>
    {pending&&<div role="alert"><p>{pending.message}</p>{selectionChanged && <p>Server status changed. Cancel and choose the action again.</p>}{pending.loss&&<label><input type="checkbox" checked={lossAccepted} onChange={event=>setLossAccepted(event.target.checked)} /> I confirm the original local source is unrecoverable and understand that unsent local sales may be missing.</label>}<button type="button" disabled={confirmDisabled} onClick={submit}>Confirm</button><button type="button" disabled={busy} onClick={()=>setPending(null)}>Cancel</button></div>}
    {error&&<p role="alert">{error}</p>}
  </div></section>;
}
