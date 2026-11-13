import React, { useEffect, useRef, useState } from 'react';
import api, { getStoredUser } from '../api/client';

const receipt = 'badizo-upload-recovery';
export default function BackupUploadRecovery() {
  const allowed = getStoredUser()?.role === 'SERVER';
  const [state, setState] = useState(null), [file, setFile] = useState(null), [error, setError] = useState('');
  const [busy, setBusy] = useState(false), [progress, setProgress] = useState(0);
  const [peerStopped, setPeerStopped] = useState(false), [lossAccepted, setLossAccepted] = useState(false);
  const refreshing = useRef(false), alive = useRef(true);
  const mutation=useRef(false),revision=useRef(0);
  useEffect(() => {
    if (!allowed) return undefined;
    alive.current = true;
    async function refresh() {
      if(mutation.current)return;
      const version=revision.current;
      try {
        const { data } = await api.get('/backup-recovery', { timeout: 5000, __badizoNoRetry: true });
        if (!alive.current || version!==revision.current) return;
        setState(data);
        if (data.job?.state === 'complete' && data.job.result?.activated && sessionStorage.getItem(receipt) === data.job.id && !refreshing.current) {
          refreshing.current = true; sessionStorage.removeItem(receipt); window.location.reload();
        }
      } catch (failure) {
        if(alive.current&&failure.response?.status===401&&sessionStorage.getItem(receipt))setError('Recovery may have switched the database. Sign in again to verify its status before billing. Old pending bills remain held for owner review.');
        else if (alive.current && failure.response?.status === 404) setError('Backup recovery is unavailable through this connection.');
        else if (alive.current) setError('Recovery status is unavailable. Do not start billing on both servers.');
      }
    }
    refresh(); const timer = setInterval(refresh, 3000);
    return () => { alive.current = false; clearInterval(timer); };
  }, [allowed]);
  if (!allowed || (!state && !error)) return null;
  const cloud = state?.nodeRole !== 'local-server';
  const job = state?.job;
  const running = job && !['uploaded', 'complete', 'failed','discarded'].includes(job.state);
  const canUpload=state?.canUpload??state?.canReplace;
  async function upload() {
    if (!file || !canUpload || !state?.supervisorOnline) return;
    if (!/\.sql(?:\.gz)?$/i.test(file.name) || file.size > state.maxUploadBytes || !file.size) { setError('Choose a nonempty SQL or SQL.GZ backup within the displayed limit.'); return; }
    setBusy(true); setError(''); setProgress(0); setLossAccepted(false); setPeerStopped(false);
    mutation.current=true;revision.current++;
    try {
      const { data } = await api.post('/backup-recovery/uploads', file, { params: { filename: file.name },
        headers: { 'Content-Type': 'application/octet-stream' }, transformRequest: [value => value],
        timeout: 15 * 60 * 1000, __badizoNoRetry: true,
        onUploadProgress: event => { if (event.total) setProgress(Math.round(event.loaded / event.total * 100)); } });
      setState(current => ({ ...current, job: data,canUpload:false }));
    } catch (failure) { setError(failure.response?.data?.error || 'The upload did not complete. No recovery is confirmed.'); }
    finally { mutation.current=false;setBusy(false); }
  }
  async function recover() {
    if (!peerStopped || !lossAccepted || busy || !state?.canReplace || !state?.supervisorOnline || job?.state !== 'uploaded') return;
    setBusy(true); setError(''); sessionStorage.setItem(receipt, job.id);
    mutation.current=true;revision.current++;
    try {
      await api.post('/backup-recovery/recover', { uploadId: job.id, expectedGeneration: state.generation,
        peerBillingStopped: true, backupAgeAccepted: true, confirmation: 'REPLACE WITH UPLOADED BACKUP AND START BILLING' }, { __badizoNoRetry: true, timeout: 10000 });
      setState(current => ({ ...current, job: { ...current.job, state: 'queued' } }));
    } catch (failure) { setError(failure.response?.data?.error || 'The recovery reply was interrupted. Wait for job status; do not upload or start a second restore.'); }
    finally { mutation.current=false;setBusy(false); }
  }
  async function discard(){
    if(busy||job?.state!=='uploaded')return;
    setBusy(true);mutation.current=true;revision.current++;
    try{const {data}=await api.post('/backup-recovery/discard',{uploadId:job.id},{__badizoNoRetry:true});setState(current=>({...current,job:data,canUpload:true}));setFile(null);setPeerStopped(false);setLossAccepted(false);}
    catch(failure){setError(failure.response?.data?.error||'Could not set aside the upload. Check recovery status.');}
    finally{mutation.current=false;setBusy(false);}
  }
  return <section className="panel system-folder-panel"><div className="panel-header green"><h2 className="panel-title">{cloud ? 'Recover cloud from backup' : 'Recover local from backup'}</h2></div>
    <div className="panel-body form-stack">
      <p>Upload the latest daily Google Drive backup, or the final cloud export when returning to local. The backup is restored and checked in a separate database before billing switches. The previous database is retained.</p>
      <p role="status">{state?.supervisorOnline ? 'Recovery supervisor online.' : 'Recovery supervisor setup or connection is required.'} {cloud && !state?.canReplace && 'Cloud must remain in standby. This flow will not replace a cloud database after cloud billing has started.'}</p>
      {state?.requiresReviewedRebaseline&&<p role="alert">This node has already activated a recovered database. Pausing billing does not allow another backup to overwrite it. A reviewed re-baseline or authority handoff is required first.</p>}
      <label>SQL / SQL.GZ backup<input type="file" accept=".sql,.gz" disabled={busy || running || !canUpload} onChange={event => { setFile(event.target.files?.[0] || null); setPeerStopped(false); setLossAccepted(false); setError(''); }} /></label>
      {state && <small>Upload limit: {Math.floor(state.maxUploadBytes / 1024 ** 2)} MB. Uploaded SQL is treated as untrusted and never imported with unrestricted database privileges.</small>}
      <button type="button" disabled={!file || busy || running || !canUpload || !state?.supervisorOnline} onClick={upload}>{busy && progress < 100 ? `Uploading ${progress}%…` : 'Upload backup'}</button>
      {job && <div role="status"><strong>{job.filename} · {job.state}</strong><p>{job.message}</p>{job.backupTime&&<p>Backup reports: {job.backupTime}</p>}{job.result && <p>{job.result.tableCount} tables · {job.result.products} products · {job.result.invoices} invoices</p>}</div>}
      {job?.state === 'uploaded' && <div role="alert">
        <p>This replaces the current billing database with the selected backup. Its timestamp and shop ownership are checked during preparation. Changes made after the backup may be missing. Daily synchronization will remain invalidated until a new baseline is verified.</p>
        <label><input type="checkbox" checked={peerStopped} onChange={event => setPeerStopped(event.target.checked)} /> The other server and all its counters are stopped or prevented from billing.</label>
        <label><input type="checkbox" checked={lossAccepted} onChange={event => setLossAccepted(event.target.checked)} /> I trust this shop backup and accept replacing this server's data, including missing transactions after the backup.</label>
        <button type="button" disabled={busy || !peerStopped || !lossAccepted || !state?.canReplace || !state?.supervisorOnline} onClick={recover}>Recover and start {cloud ? 'cloud' : 'local'} billing</button>
        <button type="button" disabled={busy} onClick={discard}>Choose a different backup</button>
      </div>}
      {running && <p>Keep this server running. Billing is enabled only after restoration, checks and restart succeed. Counters must sign in again; old pending bills stay held for owner review. After an interruption, the job is retained for inspection instead of automatically importing it again.</p>}
      {error && <p role="alert">{error}</p>}
    </div></section>;
}
