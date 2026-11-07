import React,{useEffect,useState} from 'react';
import {jsPDF} from 'jspdf';
import api,{getStoredUser} from '../api/client';
export default function FinancialConflictReview(){
  const [cases,setCases]=useState(null),[selected,setSelected]=useState(null),[note,setNote]=useState(''),[error,setError]=useState(''),[busy,setBusy]=useState(false);
  const [targetPayment,setTargetPayment]=useState(''),[confirmed,setConfirmed]=useState(false);
  const allowed=getStoredUser()?.role==='SERVER';
  async function refresh(){const {data}=await api.get('/recovery-cases');setCases(data.cases);}
  async function select(id){try{setSelected((await api.get('/recovery-cases/'+id)).data);setNote('');setError('');setTargetPayment('');setConfirmed(false);}catch{setError('Unable to load current balances.');}}
  useEffect(()=>{if(allowed)refresh().catch(()=>{});},[allowed]);
  if(!allowed||!cases)return null;
  async function retry(){setBusy(true);setError('');try{const {data}=await api.post('/recovery-cases/'+selected.id+'/retry',{expectedRevision:selected.revision,note,confirmation:'RETRY WITHOUT DISCARDING RECORDS'});setSelected(data);setNote('');setSelected((await api.get('/recovery-cases/'+selected.id)).data);await refresh();}catch(failure){setError(failure.response?.data?.error||'Unable to refresh or retry this case. Refresh the case before trying again.');}finally{setBusy(false);}}
  async function correct(action,details){setBusy(true);setError('');try{await api.post('/recovery-cases/'+selected.id+'/'+action,{expectedRevision:selected.revision,note,...details});await select(selected.id);await refresh();}catch(failure){setError(failure.response?.data?.error||'Correction could not be confirmed. Refresh before retrying.');}finally{setBusy(false);}}
  function report(){
    const doc=new jsPDF();let y=18;
    const comparisons=selected.comparison
      ? [...new Set(Object.values(selected.comparison).flatMap(Object.keys))].map(key=>[
        key.replaceAll('_',' '),
        `Sender before: ${selected.comparison.sourceBefore?.[key]??'not available'}`,
        `Sender after: ${selected.comparison.sourceAfter?.[key]??'not available'}`,
        `This server when inspected: ${selected.comparison.current?.[key]??'not available'}`
      ].join('\n'))
      : ['Refresh the case to include current balance comparisons.'];
    const actions=selected.history.map(row=>[
      `${row.at} | ${row.actor} | ${row.action||'retry-original'} | ${row.outcome}`,
      row.note,
      `Selection: ${row.selection?JSON.stringify(row.selection):'none'}`,
      row.peerDeliveryRequired?'Peer delivery required; verify synchronization status.':''
    ].filter(Boolean).join('\n'));
    const reportText=[
      'Financial / stock reconciliation',`Report generated: ${new Date().toISOString()}`,
      `Case revision: ${selected.revision}`,`Reference: ${selected.reference}`,
      `Type: ${selected.type}`,`Status: ${selected.status}`,
      `Peer correction delivery: ${selected.peerResolution?.status||'not required'}`,
      `Event: ${selected.eventId}`,`Origin: ${selected.origin}`,
      `Amount: ${selected.amount??'not applicable'}`,...comparisons,'Recorded owner actions',...actions
    ].join('\n\n').replace(/[^\x20-\x7e\n]/g,character=>'\\u'+character.charCodeAt(0).toString(16).padStart(4,'0'));
    for(const line of doc.splitTextToSize(reportText,180)){
      if(y>280){doc.addPage();y=18;}
      doc.text(line,15,y);y+=6;
    }
    doc.save('reconciliation-'+selected.eventId+'.pdf');
  }
  return <section className="panel system-folder-panel"><div className="panel-header green"><h2 className="panel-title">Financial and stock reconciliation</h2></div><div className="panel-body form-stack">
    <p>These records have not been discarded. Check the referenced bill, purchase, payment or stock adjustment on both servers. Make a documented correction in the corresponding POS screen, then retry the original update. A retry does not overwrite conflicting financial records.</p>
    <button type="button" disabled={busy} onClick={()=>refresh().catch(()=>setError('Unable to refresh cases.'))}>Refresh cases</button>
    {cases.length===0&&<p>No recorded financial conflicts.</p>}
    {cases.map(item=><button type="button" disabled={busy} key={item.id} onClick={()=>select(item.id)}>{item.reference||item.eventId} — {item.type} — {item.status}</button>)}
    {selected&&<div><p><strong>{selected.reference}</strong> · Amount: {selected.amount??'—'} · {selected.status}</p><p>Sending installation: {selected.origin}</p>
      {selected.peerResolution&&<p role="status">Correction delivery to the other server: <strong>{selected.peerResolution.status}</strong>. {selected.peerResolution.status==='pending'&&'The local correction is saved. Complete synchronization before normal switching.'}</p>}
      {selected.comparison&&<table><thead><tr><th>Value</th><th>Sender before</th><th>Sender after</th><th>This server now</th></tr></thead><tbody>{[...new Set(Object.values(selected.comparison).flatMap(Object.keys))].map(key=><tr key={key}><td>{key.replaceAll('_',' ')}</td><td>{selected.comparison.sourceBefore?.[key]??'—'}</td><td>{selected.comparison.sourceAfter?.[key]??'—'}</td><td>{selected.comparison.current?.[key]??'—'}</td></tr>)}</tbody></table>}
      <label>Correction made / verification notes<textarea value={note} onChange={event=>setNote(event.target.value)} maxLength={2000}/></label>
      {selected.correctionsAvailable&&selected.status!=='resolved'&&selected.paymentMatch&&<fieldset disabled={busy}><legend>One physical supplier payment entered twice</legend>
        <p>Use this only after checking the supplier receipt or bank statement. Both original records are retained as evidence, but counted as one payment. Two genuinely separate payments must never be matched.</p>
        <p>Incoming payment: {selected.paymentMatch.incoming.amount} · {selected.paymentMatch.incoming.payment_date} · {selected.paymentMatch.incoming.payment_mode} · Reference: {selected.paymentMatch.incoming.reference_no||'none'}</p>
        <label>Matching payment already on local<select value={targetPayment} onChange={event=>{setTargetPayment(event.target.value);setConfirmed(false);}}><option value="">Select a verified local payment</option>{selected.paymentMatch.candidates.map(payment=><option key={payment.id} value={String(payment.id)}>#{payment.id} · {payment.amount} · {payment.payment_date} · {payment.payment_mode} · {payment.reference_no||'no reference'}</option>)}</select></label>
        {!selected.paymentMatch.candidates.length&&<p>No matching local payment is available. Keep this case for financial reconciliation.</p>}
        <label><input type="checkbox" checked={confirmed} onChange={event=>setConfirmed(event.target.checked)}/> I verified these entries describe the same single physical payment.</label>
        <button type="button" disabled={!targetPayment||!confirmed||note.trim().length<10} onClick={()=>correct('match-payment',{targetPaymentId:targetPayment,confirmation:'THESE ARE THE SAME PHYSICAL PAYMENT'})}>Match the verified duplicate payment</button>
      </fieldset>}
      {selected.correctionsAvailable&&selected.status!=='resolved'&&selected.stockCorrection&&<fieldset disabled={busy}><legend>Apply a verified stock difference</legend>
        <p>This preserves local sales and other stock movements. It adds the source difference of {selected.stockCorrection.difference} to the inspected local stock {selected.stockCorrection.expectedStock}, giving {selected.stockCorrection.resultingStock}. It does not replace local stock with the cloud count.</p>
        {selected.stockCorrection.localAudits.length>0&&<><p>These pending local audits will also be applied as separate differences on cloud, only if its stock still equals {selected.stockCorrection.expectedPeerStock}:</p>{selected.stockCorrection.localAudits.map(audit=><p key={audit.eventId}>{audit.created_at} · {audit.old_qty} → {audit.new_qty} · Difference {audit.adjustment_qty} · {audit.note}</p>)}</>}
        {selected.stockCorrection.hasBatches?<p>This product has batch inventory and requires a batch-specific correction.</p>:<><label><input type="checkbox" checked={confirmed} onChange={event=>setConfirmed(event.target.checked)}/> I verified every difference listed above is a separate physical adjustment and none has been counted twice.</label>
        <button type="button" disabled={!confirmed||note.trim().length<10||Number(selected.stockCorrection.resultingStock)<0||selected.stockCorrection.localAudits.length>50} onClick={()=>correct('accept-stock-delta',{expectedStock:selected.stockCorrection.expectedStock,expectedLocalAuditIds:selected.stockCorrection.localAudits.map(audit=>audit.eventId),confirmation:'APPLY THE VERIFIED STOCK DIFFERENCE'})}>Apply the verified difference</button></>}
      </fieldset>}
      <button type="button" disabled={busy||note.trim().length<5||selected.status==='resolved'} onClick={retry}>Retry original update safely</button><button type="button" onClick={report}>Download verification PDF</button>
      {selected.history.map((entry,index)=><p key={index}>{entry.at} · {entry.actor} · {entry.action||'retry-original'} · {entry.outcome}: {entry.note}{entry.peerDeliveryRequired&&' — A peer correction was queued; its current delivery status is shown above.'}</p>)}
      {selected.status==='needs-correction'&&selected.history.length>0&&<p>The original update remains blocked. No financial record was discarded.</p>}
    </div>}{error&&<p role="alert">{error}</p>}
  </div></section>;
}
