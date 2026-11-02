import React,{useEffect,useState} from 'react';
import {jsPDF} from 'jspdf';
import api,{getStoredUser} from '../api/client';
export default function FinancialConflictReview(){
  const [cases,setCases]=useState(null),[selected,setSelected]=useState(null),[note,setNote]=useState(''),[error,setError]=useState(''),[busy,setBusy]=useState(false);
  const allowed=getStoredUser()?.role==='SERVER';
  async function refresh(){const {data}=await api.get('/recovery-cases');setCases(data.cases);}
  async function select(id){try{setSelected((await api.get('/recovery-cases/'+id)).data);setNote('');setError('');}catch{setError('Unable to load current balances.');}}
  useEffect(()=>{if(allowed)refresh().catch(()=>{});},[allowed]);
  if(!allowed||!cases)return null;
  async function retry(){setBusy(true);setError('');try{const {data}=await api.post('/recovery-cases/'+selected.id+'/retry',{expectedRevision:selected.revision,note,confirmation:'RETRY WITHOUT DISCARDING RECORDS'});setSelected(data);setNote('');setSelected((await api.get('/recovery-cases/'+selected.id)).data);await refresh();}catch(failure){setError(failure.response?.data?.error||'Unable to refresh or retry this case. Refresh the case before trying again.');}finally{setBusy(false);}}
  function report(){const doc=new jsPDF();let y=18;const comparisons=selected.comparison?[...new Set(Object.values(selected.comparison).flatMap(Object.keys))].map(key=>`${key.replaceAll('_',' ')}\nSender before: ${selected.comparison.sourceBefore?.[key]??'not available'}\nSender after: ${selected.comparison.sourceAfter?.[key]??'not available'}\nThis server when inspected: ${selected.comparison.current?.[key]??'not available'}`):['Refresh the case to include current balance comparisons.'];const lines=doc.splitTextToSize(['Financial / stock reconciliation',`Report generated: ${new Date().toISOString()}`,`Case revision: ${selected.revision}`,`Reference: ${selected.reference}`,`Type: ${selected.type}`,`Status: ${selected.status}`,`Event: ${selected.eventId}`,`Origin: ${selected.origin}`,`Amount: ${selected.amount??'not applicable'}`,...comparisons,'Recorded owner actions',...selected.history.map(row=>`${row.at} | ${row.actor} | ${row.outcome}\n${row.note}`)].join('\n\n').replace(/[^\x20-\x7e\n]/g,character=>'\\u'+character.charCodeAt(0).toString(16).padStart(4,'0')),180);for(const line of lines){if(y>280){doc.addPage();y=18;}doc.text(line,15,y);y+=6;}doc.save('reconciliation-'+selected.eventId+'.pdf');}
  return <section className="panel system-folder-panel"><div className="panel-header green"><h2 className="panel-title">Financial and stock reconciliation</h2></div><div className="panel-body form-stack">
    <p>These records have not been discarded. Check the referenced bill, purchase, payment or stock adjustment on both servers. Make a documented correction in the corresponding POS screen, then retry the original update. A retry does not overwrite conflicting financial records.</p>
    <button type="button" disabled={busy} onClick={()=>refresh().catch(()=>setError('Unable to refresh cases.'))}>Refresh cases</button>
    {cases.length===0&&<p>No recorded financial conflicts.</p>}
    {cases.map(item=><button type="button" key={item.id} onClick={()=>select(item.id)}>{item.reference||item.eventId} — {item.type} — {item.status}</button>)}
    {selected&&<div><p><strong>{selected.reference}</strong> · Amount: {selected.amount??'—'} · {selected.status}</p><p>Sending installation: {selected.origin}</p>
      {selected.comparison&&<table><thead><tr><th>Value</th><th>Sender before</th><th>Sender after</th><th>This server now</th></tr></thead><tbody>{[...new Set(Object.values(selected.comparison).flatMap(Object.keys))].map(key=><tr key={key}><td>{key.replaceAll('_',' ')}</td><td>{selected.comparison.sourceBefore?.[key]??'—'}</td><td>{selected.comparison.sourceAfter?.[key]??'—'}</td><td>{selected.comparison.current?.[key]??'—'}</td></tr>)}</tbody></table>}
      <label>Correction made / verification notes<textarea value={note} onChange={event=>setNote(event.target.value)} maxLength={2000}/></label>
      <button type="button" disabled={busy||note.trim().length<5||selected.status==='resolved'} onClick={retry}>Retry original update safely</button><button type="button" onClick={report}>Download verification PDF</button>
      {selected.history.map((entry,index)=><p key={index}>{entry.at} · {entry.actor} · {entry.outcome}: {entry.note}</p>)}
      {selected.status==='needs-correction'&&selected.history.length>0&&<p>The original update remains blocked. No financial record was discarded.</p>}
    </div>}{error&&<p role="alert">{error}</p>}
  </div></section>;
}
