import React, { useEffect, useState } from 'react';
import api, { getStoredUser } from '../api/client';
import { createRecoveryReport } from '../utils/recoveryReport';

export default function RecoveryReview() {
  const [reviews,setReviews]=useState([]),[review,setReview]=useState(null),[error,setError]=useState(''),[busy,setBusy]=useState(false),[available,setAvailable]=useState(false),[pending,setPending]=useState(null);
  const allowed=getStoredUser()?.role==='SERVER';
  useEffect(()=>{
    if(!allowed)return;
    let alive=true;
    api.get('/recovery-review').then(({data})=>{if(alive){setReviews(data.reviews);setAvailable(true);}}).catch(failure=>{
      if(alive && failure.response?.status!==404){setAvailable(true);setError('Recovery reviews could not be loaded.');}
    });
    return()=>{alive=false;};
  },[allowed]);
  if(!allowed || !available)return null;
  async function load(id) {
    setBusy(true);setPending(null);setError('');
    try {setReview((await api.get(`/recovery-review/${id}`)).data);}catch{setReview(null);setError('Unable to load this recovery review.');}finally{setBusy(false);}
  }
  async function save() {
    setBusy(true);setError('');
    try {
      setReview((await api.post(`/recovery-review/${review.plan.id}/decisions`,{expectedRevision:review.revision,side:pending.side,conflictIds:pending.ids})).data);
      setPending(null);
    } catch(failure) {setPending(null);setError(failure.response?.data?.error || 'Unable to save. Reload the review before retrying.');}
    finally{setBusy(false);}
  }
  async function applyChoices() {
    setBusy(true);setError('');
    try { setReview((await api.post(`/recovery-review/${review.plan.id}/apply`,{expectedRevision:review.revision,expectedHeadHash:review.headHash,confirmation:'APPLY REVIEWED PRODUCT CHOICES'})).data);setPending(null); }
    catch(failure){setPending(null);setError(failure.response?.data?.error || 'Application failed. Reload the review before retrying.');}
    finally{setBusy(false);}
  }
  function download() {
    const url=URL.createObjectURL(new Blob([JSON.stringify(review,null,2)],{type:'application/json'}));
    const link=document.createElement('a');link.href=url;link.download=`recovery-${review.plan.shopId}-${review.plan.id.slice(0,12)}-revision-${review.revision}.json`;link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
  }
  async function downloadPdf() {
    setBusy(true);setError('');
    try {
      const saved=(await api.get(`/recovery-review/${review.plan.id}`)).data;
      setReview(saved);setPending(null);
      createRecoveryReport(saved).save(`recovery-${saved.plan.shopId}-revision-${saved.revision}.pdf`);
    } catch {setError('Unable to generate the report from saved decisions. Please retry.');}
    finally {setBusy(false);}
  }
  const conflicts=review?.plan.entries.filter(entry=>entry.state==='conflict') || [];
  const unresolved=new Set(review?.unresolvedConflictIds || []);
  const bulk=conflicts.filter(entry=>entry.bulkEligible && unresolved.has(entry.id)).map(entry=>entry.id);
  const decisions=new Map((review?.decisions || []).map(decision=>[decision.conflictId,decision]));
  return <section className="panel system-folder-panel">
    <div className="panel-header green"><h2 className="panel-title">Recovery review</h2></div>
    <div className="panel-body form-stack">
      <p>Review saved differences between local and cloud. Saving choices does not transfer data or change where billing runs.</p>
      <label>Recovery session <select className="select" disabled={busy} value={review?.plan.id || ''} onChange={event=>event.target.value && load(event.target.value)}>
        <option value="">Select a session</option>{reviews.map(item=><option key={item.id} value={item.id}>{item.baselineId} — {item.id.slice(0,12)}</option>)}
      </select></label>
      {!reviews.length && <p>No recovery sessions are available.</p>}
      {review && <>
        <p>Shop: {review.plan.shopId} · Revision: {review.revision} · Unresolved: {unresolved.size}</p>
        <div className="settings-action-row">
          <button type="button" disabled={busy || review.applied || !bulk.length} onClick={()=>setPending({side:'local',ids:bulk})}>Use local for all eligible conflicts</button>
          <button type="button" disabled={busy || review.applied || !bulk.length} onClick={()=>setPending({side:'cloud',ids:bulk})}>Use cloud for all eligible conflicts</button>
          <button type="button" disabled={busy || !review.canApply || review.applied || unresolved.size > 0} onClick={()=>setPending({apply:true})}>Apply saved product choices</button>
          <button type="button" disabled={busy} onClick={download}>Download decision history</button>
          <button type="button" disabled={busy} onClick={downloadPdf}>Download verification PDF</button>
          <button type="button" disabled={busy} onClick={()=>load(review.plan.id)}>Reload review</button>
        </div>
        {pending?.apply && <div role="alert"><p>Apply the saved product choices locally and queue the corresponding cloud updates? Billing mode will stay unchanged.</p><button type="button" disabled={busy} onClick={applyChoices}>Confirm application</button><button type="button" disabled={busy} onClick={()=>setPending(null)}>Cancel</button></div>}
        {pending && !pending.apply && <div role="alert"><p>Use {pending.side} values for {pending.ids.length} product conflicts? Both original values will remain in the history.</p><button type="button" disabled={busy} onClick={save}>Confirm choices</button><button type="button" disabled={busy} onClick={()=>setPending(null)}>Cancel</button></div>}
        <div style={{overflowX:'auto'}}><table><thead><tr><th>Record / field</th><th>Original</th><th>Local</th><th>Cloud</th><th>Decision</th></tr></thead><tbody>
          {conflicts.map(entry=><tr key={entry.id}><td>{entry.recordId} / {entry.field}</td><td>{String(entry.base)}</td><td>{String(entry.local)}</td><td>{String(entry.cloud)}</td><td>
            {decisions.has(entry.id) && <p>{decisions.get(entry.id).chosenSide} · {decisions.get(entry.id).actor}</p>}
            {entry.bulkEligible ? <><button type="button" disabled={busy || review.applied} onClick={()=>setPending({side:'local',ids:[entry.id]})}>Keep local</button><button type="button" disabled={busy || review.applied} onClick={()=>setPending({side:'cloud',ids:[entry.id]})}>Keep cloud</button></> : 'Requires specialist review; bulk choice unavailable.'}
          </td></tr>)}
        </tbody></table></div>
        <p>{review.applied ? 'Saved product choices were applied locally. Cloud updates are queued for transfer; this does not confirm cloud synchronization or switch billing.' : 'Saved choices have not been applied. Billing mode is unchanged.'}</p>
      </>}
      {error && <p role="alert">{error}</p>}
    </div>
  </section>;
}
