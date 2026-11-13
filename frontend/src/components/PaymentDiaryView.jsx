import React, { useCallback, useEffect, useRef, useState } from 'react';
import api from '../api/client';
import * as XLSX from 'xlsx';
import { todayIso } from '../utils/date';

const base='/local-payment-diary';
const amount=value=>new Intl.NumberFormat('en-IN',{style:'currency',currency:'INR'}).format(Number(value||0));
const yearOf=value=>Number(value.slice(0,4))-(value.slice(5,7)<'04'?1:0);
const newId=()=>globalThis.crypto?.randomUUID?.()||`diary-${Date.now()}-${Math.random().toString(36).slice(2)}`;
const errorText=error=>error.response?.data?.error||error.message||'Unable to complete the operation.';
const readDraft=key=>{try{return JSON.parse(sessionStorage.getItem(key)||'null');}catch{return null;}};
const afterDays=(day,days)=>{const d=new Date(`${day}T12:00:00Z`);d.setUTCDate(d.getUTCDate()+Number(days||0));return Number.isFinite(d.getTime())?d.toISOString().slice(0,10):day;};
export function groupDiaryBills(rows) {
  const groups=new Map();
  for(const row of rows){
    const day=row.reminder_date||row.due_date;
    const key=JSON.stringify([row.account_scope,String(row.account_name).trim().toUpperCase(),day]);
    if(!groups.has(key))groups.set(key,{key,account_name:row.account_name,account_scope:row.account_scope,date:day,rows:[],pendingCents:0});
    const group=groups.get(key);group.rows.push(row);group.pendingCents+=Math.round(Number(row.pending_amount||0)*100);
  }
  return [...groups.values()].sort((a,b)=>a.date.localeCompare(b.date)||a.account_name.localeCompare(b.account_name));
}
function DiaryGroupHeading({group,columns}) {
  return group.rows.length>1?<tr className="diary-group-heading"><td colSpan={columns}><strong>{group.account_name} · {group.account_scope==='LOCAL'?'Local':'Non-Local'} · Reminder {group.date} · {group.rows.length} bills · Total pending {amount(group.pendingCents/100)}</strong></td></tr>:null;
}
function notify(){window.dispatchEvent(new Event('badizo-local-diary-updated'));}

function DiaryEditDialog({row,mode,onClose,onSaved}) {
  const [form,setForm]=useState({account_scope:row.account_scope,account_name:row.account_name,bill_no:row.bill_no.startsWith('REM-')?'':row.bill_no,bill_date:row.bill_date,due_date:row.due_date,amount:String(row.amount),notes:row.notes||'',reason:''});
  const [error,setError]=useState(''),[busy,setBusy]=useState(false),[names,setNames]=useState([]);
  const request=useRef(newId()),saving=useRef(false);
  const settled=Number(row.paid_amount||0)+Number(row.discount_amount||0)>0;
  const locked=settled||row.carried_forward;
  const title=mode==='EDIT'?'Edit reminder':mode==='DELETE'?'Delete reminder':'Restore reminder';
  const change=(key,value)=>setForm(current=>({...current,[key]:value}));
  useEffect(()=>{let cancelled=false;setNames([]);if(mode!=='EDIT'||locked||form.account_name.length<3)return;const timer=setTimeout(()=>api.get(`${base}/accounts`,{params:{scope:form.account_scope,search:form.account_name}}).then(({data})=>{if(!cancelled)setNames(data);}).catch(()=>{}),250);return()=>{cancelled=true;clearTimeout(timer);};},[mode,locked,form.account_scope,form.account_name]);
  async function save(event){event.preventDefault();if(saving.current)return;saving.current=true;setBusy(true);setError('');try{
    const payload={...form,bill_no:form.bill_no.trim()||(row.bill_no.startsWith('REM-')?row.bill_no:`REM-${request.current}`),version:row.version||0,request_id:request.current};
    if(mode==='EDIT')await api.put(`${base}/${row.id}`,payload);
    else if(mode==='DELETE')await api.delete(`${base}/${row.id}`,{data:payload});
    else await api.post(`${base}/${row.id}/restore`,payload);
    notify();onSaved();
  }catch(e){setError(errorText(e));}finally{saving.current=false;setBusy(false);}}
  return <div className="diary-overlay"><section className="diary-dialog" role="dialog" aria-modal="true" aria-label={title}><h2>{title}</h2><p><strong>{row.account_name}</strong> · {row.bill_no}</p>
    {mode==='DELETE'&&settled?<><p className="form-error">Payment or discount is already posted to this ledger. Reverse it in History before deleting the reminder.</p><button onClick={onClose}>Close</button></>:<form onSubmit={save}>
      {mode==='EDIT'&&<><p className="muted">{locked?'Payments / previous-year history are retained. You can update the due date and remarks.':'Change the reminder details below. No purchase entry is added.'}</p><div className="diary-form-grid">
        <label>Account type<select disabled={locked} value={form.account_scope} onChange={e=>change('account_scope',e.target.value)}><option value="LOCAL">Local</option><option value="NON_LOCAL">Non-Local</option></select></label>
        <label>Account name<input disabled={locked} value={form.account_name} onChange={e=>change('account_name',e.target.value)} required/></label>
        {!locked&&names.length>0&&<div className="diary-suggestions diary-full">{names.map(n=><button type="button" key={n.account_name} onClick={()=>{change('account_name',n.account_name);setNames([]);}}>{n.account_name}</button>)}</div>}
        <label>Invoice number (optional)<input disabled={locked} value={form.bill_no} onChange={e=>change('bill_no',e.target.value)} maxLength={100}/></label>
        <label>Amount<input disabled={locked} type="number" min="0.01" step="0.01" value={form.amount} onChange={e=>change('amount',e.target.value)} required/></label>
        <label>Bill date<input disabled={locked} type="date" max={todayIso()} value={form.bill_date} onChange={e=>change('bill_date',e.target.value)} required/></label>
        <label>Due date<input type="date" value={form.due_date} onChange={e=>change('due_date',e.target.value)} required/></label>
        <label className="diary-full">Remarks<input value={form.notes} onChange={e=>change('notes',e.target.value)} maxLength={500}/></label>
      </div></>}
      {mode==='DELETE'&&<p>This removes the reminder from pending lists and daily popups. You can restore it from Deleted reminders. Ledger entries are not deleted.</p>}
      {mode==='RESTORE'&&<p>This returns the reminder to the diary and daily reminders. It does not post a payment.</p>}
      <label>Reason<input value={form.reason} onChange={e=>change('reason',e.target.value)} maxLength={255} required/></label>
      {error&&<p className="form-error" role="alert">{error}</p>}<div className="diary-actions"><button type="button" onClick={onClose} disabled={busy}>Cancel</button><button className="primary-button" disabled={busy}>{busy?'Saving…':mode==='EDIT'?'Save changes':mode==='DELETE'?'Confirm delete':'Restore reminder'}</button></div>
    </form>}
  </section></div>;
}

export function DiaryPaymentDialog({row,onClose,onSaved}) {
  const key=`badizo_diary_payment_${row.id}`;
  const prior=useRef(readDraft(key));
  const [form,setForm]=useState(()=>prior.current?.form||{payment_date:todayIso(),paid_amount:Number(row.pending_amount).toFixed(2),discount_amount:'0',payment_mode:'Cash',bank_name:'',reference_no:'',notes:''});
  const request=useRef(prior.current?.request_id||newId()),busyRef=useRef(false);
  const [busy,setBusy]=useState(false),[error,setError]=useState('');
  const change=(field,value)=>setForm(current=>({...current,[field]:value}));
  const remaining=Math.round((Number(row.pending_amount)-Number(form.paid_amount||0)-Number(form.discount_amount||0))*100)/100;
  async function save(event){event.preventDefault();if(busyRef.current)return;busyRef.current=true;setBusy(true);setError('');
    try{sessionStorage.setItem(key,JSON.stringify({form,request_id:request.current}));
      await api.post(`${base}/${row.id}/payments`,{...form,version:row.version||0,request_id:request.current});
      sessionStorage.removeItem(key);notify();onSaved();
    }catch(e){setError(errorText(e));}finally{busyRef.current=false;setBusy(false);}
  }
  return <div className="diary-overlay"><section className="diary-dialog" role="dialog" aria-modal="true" aria-labelledby="diary-pay-title">
    <h2 id="diary-pay-title">Record payment</h2><p><strong>{row.account_name}</strong> · {row.account_scope==='LOCAL'?'Local':'Non-Local'} · Bill {row.bill_no}</p>
    <p>Pending: <strong>{amount(row.pending_amount)}</strong></p>
    <form onSubmit={save}><div className="diary-form-grid">
      <label>Payment date<input type="date" max={todayIso()} value={form.payment_date} onChange={e=>change('payment_date',e.target.value)} required/></label>
      <label>Payment through<select value={form.payment_mode} onChange={e=>change('payment_mode',e.target.value)}>{['Cash','Bank','UPI'].map(mode=><option key={mode}>{mode}</option>)}</select></label>
      <label>Paid amount<input type="number" min="0" step="0.01" value={form.paid_amount} onChange={e=>change('paid_amount',e.target.value)} required/></label>
      <label>Less / Discount<input type="number" min="0" step="0.01" value={form.discount_amount} onChange={e=>change('discount_amount',e.target.value)} required/></label>
      {form.payment_mode!=='Cash'&&<label>Bank / account name<input value={form.bank_name} maxLength={120} onChange={e=>change('bank_name',e.target.value)} required={form.payment_mode==='Bank'}/></label>}
      <label>Transaction ID / UTR (optional)<input value={form.reference_no} maxLength={120} onChange={e=>change('reference_no',e.target.value)}/></label>
      <label className="diary-full">Remarks<input value={form.notes} maxLength={500} onChange={e=>change('notes',e.target.value)}/></label>
    </div><p className={remaining<0?'form-error':''}>Balance after this payment: <strong>{amount(remaining)}</strong></p>
    <p className="muted">Payment and discount post as separate CR entries in this Local/Non-Local ledger only. No purchase entry is added.</p>
    {error&&<p className="form-error" role="alert">{error}</p>}
    <div className="diary-actions"><button type="button" onClick={onClose} disabled={busy}>Cancel</button><button className="primary-button" disabled={busy||remaining<0||Number(form.paid_amount||0)+Number(form.discount_amount||0)<=0}>{busy?'Saving…':'Confirm payment & post to ledger'}</button></div></form>
  </section></div>;
}

function DiaryHistory({row,onClose,onChanged}) {
  const [rows,setRows]=useState([]),[changes,setChanges]=useState([]),[error,setError]=useState(''),[reversal,setReversal]=useState(null),[busy,setBusy]=useState(false);
  const load=useCallback(()=>Promise.all([api.get(`${base}/${row.id}/payments`),api.get(`${base}/${row.id}/changes`)]).then(([payments,history])=>{setRows(payments.data);setChanges(history.data);}).catch(e=>setError(errorText(e))),[row.id]);
  useEffect(()=>{load();},[load]);
  async function reverse(event){event.preventDefault();if(busy)return;setBusy(true);setError('');try{
    await api.post(`${base}/payments/${reversal.id}/reverse`,{reason:reversal.reason,reversal_date:todayIso(),request_id:reversal.request_id});
    setReversal(null);notify();await load();onChanged();
  }catch(e){setError(errorText(e));}finally{setBusy(false);}}
  return <div className="diary-overlay"><section className="diary-dialog diary-dialog-wide" role="dialog" aria-modal="true" aria-label="Payment history"><h2>{row.account_name} · Bill {row.bill_no}</h2>
    <div className="diary-table-wrap"><table><thead><tr><th>Date</th><th>Through / reference</th><th>Paid</th><th>Less</th><th>Recorded by</th><th>Action</th></tr></thead><tbody>{rows.map(p=><tr key={p.id}><td>{p.payment_date}</td><td>{p.payment_mode}<br/>{p.bank_name} {p.reference_no}<small>{p.notes}</small></td><td>{amount(p.paid_amount)}</td><td>{amount(p.discount_amount)}</td><td>{p.created_by}</td><td>{p.reversed_date?<span>Reversed {p.reversed_date}<small>{p.reversal_reason}</small></span>:<button onClick={()=>setReversal({id:p.id,reason:'',request_id:newId()})}>Reverse</button>}</td></tr>)}</tbody></table>{!rows.length&&<p>No payments recorded.</p>}</div>
    {reversal&&<form onSubmit={reverse}><label>Reason for reversal<input value={reversal.reason} onChange={e=>setReversal({...reversal,reason:e.target.value})} required maxLength={255}/></label><p>This adds opposite DR entries today and reopens the pending balance. Original entries remain in history.</p><button disabled={busy}>Confirm reversal</button><button type="button" disabled={busy} onClick={()=>setReversal(null)}>Cancel reversal</button></form>}
    <h3>Reminder change history</h3>{!changes.length&&<p>No reminder edits or deletions.</p>}{changes.map(change=><div key={change.id}><strong>{change.event_date} · {change.change_type} · {change.created_by}</strong><p>{change.reason}</p></div>)}
    {error&&<p className="form-error" role="alert">{error}</p>}<button onClick={onClose} disabled={busy}>Close history</button>
  </section></div>;
}

export function PaymentDiaryReminder({user,onOpenDiary}) {
  const allowed=['SERVER','ADMIN'].includes(user?.role);
  const [rows,setRows]=useState([]),[visible,setVisible]=useState(false),[payment,setPayment]=useState(null);
  const minimized=useRef(false);
  const dayKey=()=>`badizo_diary_reminder_${user?.username}_${todayIso()}`;
  const load=useCallback(async(force=false)=>{if(!allowed)return;try{const {data}=await api.get(base,{params:{status:'ALL',include_payments:true}});
    const due=data.rows.filter(row=>(row.reminder_date||row.due_date)===data.today||(row.payments||[]).some(p=>p.payment_date===data.today&&!p.reversed_date));setRows(due);
    if(due.length&&!minimized.current&&(force||!sessionStorage.getItem(dayKey())))setVisible(true);
    if(!due.length)setVisible(false);
  }catch{/* Leave billing and ledgers available if the reminder cannot load. */}},[allowed,user?.username]);
  useEffect(()=>{if(!allowed)return;load();const timer=setInterval(()=>load(),60000);const update=()=>load();window.addEventListener('badizo-local-diary-updated',update);return()=>{clearInterval(timer);window.removeEventListener('badizo-local-diary-updated',update);};},[allowed,load]);
  if(!allowed)return null;
  const close=()=>{sessionStorage.setItem(dayKey(),'dismissed');setVisible(false);};
  return <>{!visible&&!payment&&rows.length>0&&minimized.current&&<button style={{position:'fixed',bottom:18,right:18,zIndex:1200}} onClick={()=>{minimized.current=false;setVisible(true);}}>Today's payments ({rows.length}) · Restore</button>}{visible&&!payment&&<div className="diary-overlay"><section className="diary-dialog diary-dialog-wide" style={{borderTop:'6px solid #2e7d32'}} role="dialog" aria-modal="true" aria-labelledby="diary-reminder-title"><button style={{float:'right'}} aria-label="Minimize payment reminder" onClick={()=>{minimized.current=true;setVisible(false);}}>− Minimize</button><p style={{margin:'0 0 8px',fontWeight:700,color:'#216331'}}><time dateTime={todayIso()}>{reportDate(todayIso())}</time></p><h2 id="diary-reminder-title">Today's Local / Non-Local payments</h2><p>{rows.length} bills · {rows.filter(row=>Number(row.pending_amount)<=0).length} paid · {rows.filter(row=>Number(row.pending_amount)>0).length} pending · Balance <strong>{amount(rows.reduce((sum,row)=>sum+Number(row.pending_amount||0),0))}</strong></p>
    <div className="diary-table-wrap"><table><thead><tr><th>Account / bill</th><th>Due date</th><th>Pending / status</th><th>Action</th></tr></thead><tbody>{groupDiaryBills(rows).map(group=><React.Fragment key={group.key}><DiaryGroupHeading group={group} columns={4}/>{group.rows.map(row=><tr key={row.id}><td><strong>{row.account_name}</strong><small>{row.account_scope==='LOCAL'?'Local':'Non-Local'} · {row.bill_no}</small><small>Bill {row.bill_date} · Amount {amount(row.amount)}</small></td><td>{row.reminder_date||row.due_date}{row.reminder_date&&row.reminder_date!==row.due_date&&<small>Sunday due {row.due_date} · reminding Saturday</small>}{Number(row.pending_amount)>0?(row.due_date<todayIso()?' · OVERDUE':' · DUE TODAY'):' · PAID'}</td><td><strong>{amount(row.pending_amount)}</strong><small>{Number(row.pending_amount)<=0?'PAID':Number(row.paid_amount)>0?'PART PAID · Balance pending':'UNPAID'}</small>{Number(row.paid_amount)>0&&<small>Paid {amount(row.paid_amount)} · Less {amount(row.discount_amount)}</small>}</td><td>{Number(row.pending_amount)>0?<button className="diary-payment-pending" onClick={()=>setPayment(row)}>Record payment</button>:<button className="diary-payment-ok" disabled>✓ Payment OK</button>}</td></tr>)}</React.Fragment>)}</tbody></table></div>
    <div className="diary-actions"><button onClick={close}>Close for today</button><button className="primary-button" onClick={()=>{close();onOpenDiary();}}>Open Payment Diary</button></div><small>Closing does not mark bills paid. Find older unpaid bills in Payment Diary.</small>
  </section></div>}{payment&&<DiaryPaymentDialog row={payment} onClose={()=>setPayment(null)} onSaved={()=>{setPayment(null);load(true);}}/>}</>;
}

const reportDate=value=>value?String(value).split('-').reverse().join('/'):'—';
function PaymentStatement({rows,summary,onHistory}) {
  const dates=[...new Set(rows.map(p=>p.payment_date))];
  return <section className="panel diary-table-panel diary-statement">
    <header className="statement-cover"><div><span className="statement-eyebrow">LOCAL / NON-LOCAL ACCOUNTS</span><h3>Payment statement</h3><p className="statement-period">{summary.from===summary.to?reportDate(summary.from):reportDate(summary.from)+' – '+reportDate(summary.to)}</p><small>Payments recorded for the selected dates</small></div><span className="statement-report-label">PAYMENT DIARY</span></header>
    <div className="statement-metrics">{[['Payments',summary.count||0],['Total paid',amount(summary.paid)],['Discount',amount(summary.discount)],['Total settled',amount(Number(summary.paid||0)+Number(summary.discount||0))]].map(([label,value])=><div key={label}><span>{label}</span><strong>{value}</strong></div>)}</div>
    <div className="diary-table-wrap"><table className="statement-table"><thead><tr><th>Paid on</th><th>Account / bill</th><th>Due date</th><th className="statement-money">Paid amount</th><th className="statement-money">Discount</th><th>Payment details</th><th className="statement-action">History</th></tr></thead><tbody>{dates.map(day=>{const total=summary.days?.find(d=>d.date===day);return <React.Fragment key={day}><tr className="statement-day"><td colSpan={7}><div><strong>{reportDate(day)}</strong><span>{total?.count||0} payments <span aria-hidden="true">·</span> Paid <b>{amount(total?.paid)}</b> <span aria-hidden="true">·</span> Discount {amount(total?.discount)} <span aria-hidden="true">·</span> Settled <b>{amount(total?.total)}</b></span></div></td></tr>{rows.filter(p=>p.payment_date===day).map(p=><tr key={p.id}><td className="statement-date">{reportDate(p.payment_date)}{p.reversed&&<small className="statement-reversal">Reversed {reportDate(p.reversed_date)} · excluded from totals</small>}</td><td><strong className="statement-account">{p.account_name}</strong><div className="statement-account-meta"><span>{p.account_scope==='LOCAL'?'Local':'Non-Local'}</span><small>Bill {p.bill_no}</small></div></td><td className="statement-date">{reportDate(p.due_date)}</td><td className="statement-money"><strong>{amount(p.paid_amount)}</strong></td><td className="statement-money">{amount(p.discount_amount)}</td><td><div className="statement-payment"><span className="statement-mode">{p.payment_mode}</span>{p.bank_name&&<span>{p.bank_name}</span>}</div>{p.reference_no&&<small>Reference: {p.reference_no}</small>}{p.notes&&<small>{p.notes}</small>}<small className="statement-by">Recorded by {p.created_by}</small></td><td className="statement-action"><button onClick={()=>onHistory({id:p.diary_id,account_name:p.account_name,bill_no:p.bill_no})}>History ↗</button></td></tr>)}</React.Fragment>;})}</tbody><tfoot><tr><td colSpan={3}>TOTAL · {summary.count||0} PAYMENTS</td><td className="statement-money">{amount(summary.paid)}</td><td className="statement-money">{amount(summary.discount)}</td><td colSpan={2}>Settled {amount(Number(summary.paid||0)+Number(summary.discount||0))}</td></tr></tfoot></table></div>{!rows.length&&<p className="statement-empty">No payments recorded for these payment dates and filters.</p>}
  </section>;
}

export default function PaymentDiaryView({isActive=true}) {
  const [filters,setFilters]=useState({scope:readDraft('badizo_diary_new')?.scope||'LOCAL',year:yearOf(todayIso()),status:'PENDING',from:'',to:'',search:''});
  const [searchText,setSearchText]=useState('');
  const appliedFilters=useRef(null);
  const [hasResults,setHasResults]=useState(false);
  const [data,setData]=useState({rows:[],summary:{},active_year:yearOf(todayIso()),earliest_year:yearOf(todayIso()),closed_years:[]});
  const [form,setForm]=useState(()=>readDraft('badizo_diary_new')?.form||{account_name:'',bill_no:'',bill_date:todayIso(),due_date:afterDays(todayIso(),7),credit_days:'7',amount:'',notes:''});
  const request=useRef(readDraft('badizo_diary_new')?.request_id||newId()),saving=useRef(false),loadNo=useRef(0);
  const [suggestions,setSuggestions]=useState([]),[error,setError]=useState(''),[message,setMessage]=useState(''),[busy,setBusy]=useState(false),[loading,setLoading]=useState(false),[payment,setPayment]=useState(null),[history,setHistory]=useState(null),[editing,setEditing]=useState(null);
  const load=useCallback(async(query=appliedFilters.current)=>{if(!query)return;const n=++loadNo.current;setLoading(true);try{const {data:result}=await api.get(base,{params:query});if(n===loadNo.current){setData(result);setError('');}}catch(e){if(n===loadNo.current)setError(errorText(e));}finally{if(n===loadNo.current)setLoading(false);}},[]);
  useEffect(()=>{if(!isActive)return;const timer=setTimeout(()=>load(),200);return()=>clearTimeout(timer);},[isActive,load]);
  useEffect(()=>{const refresh=()=>load();window.addEventListener('badizo-local-diary-updated',refresh);return()=>window.removeEventListener('badizo-local-diary-updated',refresh);},[load]);
  useEffect(()=>{let cancelled=false;setSuggestions([]);if(form.account_name.trim().length<3)return;const timer=setTimeout(()=>api.get(`${base}/accounts`,{params:{scope:filters.scope,search:form.account_name}}).then(({data})=>{if(!cancelled)setSuggestions(data);}).catch(()=>{}),200);return()=>{cancelled=true;clearTimeout(timer);};},[form.account_name,filters.scope]);
  const change=(field,value)=>setForm(current=>({...current,[field]:value,...(field==='bill_date'?{due_date:afterDays(value,current.credit_days)}:field==='credit_days'?{due_date:afterDays(current.bill_date,value)}:{})}));
  const filter=(key,value)=>setFilters(current=>({...current,[key]:value}));
  const applyFilters=next=>{setFilters(next);appliedFilters.current=next;setHasResults(true);setError('');load(next);};
  const showSearch=()=>{const next={...filters,search:searchText.trim(),include_payments:true};if(!next.from&&!next.to&&!next.search){setError('Enter an account / bill or select a reminder date/month, then click Show.');return;}if(next.from&&next.to&&next.from>next.to){setError('From date must be before or equal to To date.');return;}applyFilters(next);};
  const clearSearch=()=>{loadNo.current++;appliedFilters.current=null;setHasResults(false);setLoading(false);setSearchText('');setError('');setMessage('');setFilters(current=>({...current,scope:current.scope==='ALL'?'LOCAL':current.scope,period:'',from:'',to:'',search:''}));setData(current=>({...current,rows:[],summary:{}}));};
  const resetSearch=()=>{clearSearch();setFilters(current=>({...current,year:yearOf(todayIso()),status:'PENDING',from:'',to:'',search:''}));};
  const statementMode=appliedFilters.current?.period==='PREVIOUS';
  const active=Number(filters.year)===data.active_year;
  async function add(event){event.preventDefault();if(saving.current)return;saving.current=true;setBusy(true);setError('');setMessage('');try{
    sessionStorage.setItem('badizo_diary_new',JSON.stringify({form,scope:filters.scope,request_id:request.current}));
    // An invoice is optional. Keep a stable diary reference for retries and
    // allow multiple unnumbered reminders for the same account on one day.
    await api.post(base,{...form,bill_no:form.bill_no.trim()||`REM-${request.current}`,account_scope:filters.scope,request_id:request.current});
    sessionStorage.removeItem('badizo_diary_new');request.current=newId();setForm(current=>({...current,bill_no:'',amount:'',notes:''}));setMessage('Reminder added. Purchase ledger entries were not duplicated.');notify();await load();
  }catch(e){setError(errorText(e));}finally{saving.current=false;setBusy(false);}}
  async function closeYear(){setError('');try{await api.post(`${base}/close-year`,{year:Number(filters.year)});setMessage('Year closed. Unpaid balances are carried into the next year automatically; original history is retained.');await load();}catch(e){setError(errorText(e));}}
  function exportExcel(){
    if(statementMode){
      const summary=data.statement_summary||{};
      const book=XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(book,XLSX.utils.json_to_sheet([{'Payment from':reportDate(summary.from),'Payment to':reportDate(summary.to),'Account type':appliedFilters.current.scope,'Payments':summary.count,'Total paid':summary.paid,'Discount':summary.discount,'Total settled':Number(summary.paid||0)+Number(summary.discount||0)},...(summary.days||[]).map(d=>({'Payment from':reportDate(d.date),'Payment to':reportDate(d.date),'Payments':d.count,'Total paid':d.paid,'Discount':d.discount,'Total settled':d.total}))]),'Statement totals');
      XLSX.utils.book_append_sheet(book,XLSX.utils.json_to_sheet((data.statement||[]).map(p=>({'Paid on':reportDate(p.payment_date),'Account type':p.account_scope,'Account':p.account_name,'Bill':p.bill_no,'Due date':reportDate(p.due_date),'Paid amount':Number(p.paid_amount),'Discount':Number(p.discount_amount),'Through':p.payment_mode,'Bank':p.bank_name||'','Reference':p.reference_no||'','Remarks':p.notes||'','Recorded by':p.created_by,'Reversed on':p.reversed_date?reportDate(p.reversed_date):'','Included in totals':!p.reversed}))), 'Payments');
      XLSX.writeFile(book,'payment-statement-'+summary.from+'-'+summary.to+'.xlsx');return;
    }
    const rows=groupDiaryBills(data.rows).flatMap(group=>group.rows);
    const sheet=XLSX.utils.json_to_sheet(rows.map(r=>({'Scope':r.account_scope,'Account':r.account_name,'Bill':r.bill_no,'Bill date':reportDate(r.bill_date),'Due date':reportDate(r.due_date),'Reminder date':reportDate(r.reminder_date||r.due_date),'Amount':Number(r.amount),'Paid':Number(r.paid_amount),'Discount':Number(r.discount_amount),'Pending':Number(r.pending_amount),'Status':r.status,'Remarks':r.notes||''})));
    const book=XLSX.utils.book_new();XLSX.utils.book_append_sheet(book,sheet,'Payment Diary');
    const payments=rows.flatMap(r=>(r.payments||[]).map(p=>({'Account':r.account_name,'Bill':r.bill_no,'Pay on':reportDate(r.due_date),'Paid on':reportDate(p.payment_date),'Paid amount':Number(p.paid_amount),'Discount':Number(p.discount_amount),'Through':p.payment_mode,'Bank':p.bank_name||'','Reference':p.reference_no||'','Remarks':p.notes||'','Recorded by':p.created_by,'Reversed on':p.reversed_date?reportDate(p.reversed_date):'','Reversal reason':p.reversal_reason||''})));
    if(payments.length)XLSX.utils.book_append_sheet(book,XLSX.utils.json_to_sheet(payments),'Payments');
    XLSX.writeFile(book,'payment-diary-'+appliedFilters.current.year+'-'+appliedFilters.current.scope+'.xlsx');
  }
  return <div className="payment-diary"><div className="diary-heading"><div><h2>Local / Non-Local Payment Diary</h2><p>Reminders and outgoing payments linked only to your existing account ledgers. Sunday dues are reminded on the preceding Saturday.</p></div><div className="diary-actions"><button onClick={()=>applyFilters({...filters,scope:filters.scope==='ALL'?'LOCAL':filters.scope,from:'',to:todayIso(),period:'',status:'PENDING',search:searchText.trim()})}>Today's dues / overdue</button><button disabled={!hasResults||loading||!data.rows.length} onClick={exportExcel}>Export Excel</button><button onClick={()=>applyFilters({...filters,scope:'ALL',year:yearOf(afterDays(todayIso(),-1)),from:afterDays(todayIso(),-1),to:afterDays(todayIso(),-1),status:'ALL',include_payments:true,period:'PREVIOUS',search:searchText.trim()})}>Previous diary</button><button onClick={()=>applyFilters({...filters,scope:filters.scope==='ALL'?'LOCAL':filters.scope,from:afterDays(todayIso(),1),to:'',period:'',status:'PENDING',search:searchText.trim()})}>Upcoming payments</button><button onClick={()=>applyFilters({...filters,scope:filters.scope==='ALL'?'LOCAL':filters.scope,from:'',to:'',status:'ALL',include_payments:true,period:'',search:searchText.trim()})}>All diary</button><button onClick={()=>load()}>Refresh</button></div></div>
    <div className="diary-summary" hidden={statementMode}>{(statementMode?[['Paid in selected dates','paid'],['Less / Discount','discount']]:[['Due / overdue','due'],['Upcoming pending','upcoming'],['Total pending','pending'],['Paid','paid'],['Less / Discount','discount']]).map(([label,key])=><div key={key}><span>{label}</span><strong>{amount(data.summary[key])}</strong></div>)}</div>
    <div className="diary-filter" role="search"><label>Account type<select value={filters.scope} onChange={e=>{filter('scope',e.target.value);setForm(current=>({...current,account_name:''}));}}>{filters.period==='PREVIOUS'&&<option value="ALL">Local + Non-Local</option>}<option value="LOCAL">Local</option><option value="NON_LOCAL">Non-Local</option></select></label>
      <label>Financial year<select value={filters.year} onChange={e=>filter('year',Number(e.target.value))}>{Array.from({length:Math.max(1,data.active_year-data.earliest_year+1)},(_,i)=>data.active_year-i).map(year=><option key={year} value={year}>{year}–{String(year+1).slice(-2)}{year===data.active_year?' (Active)':''}</option>)}</select></label>
      <label>Status<select disabled={filters.period==='PREVIOUS'} value={filters.status} onChange={e=>filter('status',e.target.value)}><option value="PENDING">Pending / Part paid</option><option value="PAID">Paid history</option><option value="ALL">All</option><option value="DELETED">Deleted reminders</option></select></label>
      <label>{filters.period==='PREVIOUS'?'Payment month':'Reminder month'}<select value="" onChange={e=>{const month=Number(e.target.value);if(!month)return;const year=Number(filters.year)+(month<4?1:0),last=new Date(Date.UTC(year,month,0)).getUTCDate(),prefix=`${year}-${String(month).padStart(2,'0')}`;setFilters(current=>({...current,from:`${prefix}-01`,to:`${prefix}-${last}`}));}}><option value="">Choose month…</option>{[4,5,6,7,8,9,10,11,12,1,2,3].map(month=><option key={month} value={month}>{new Date(2026,month-1,1).toLocaleString('en',{month:'long'})}</option>)}</select></label>
      <label>{filters.period==='PREVIOUS'?'Payment from':'Reminder from'}<input type="date" value={filters.from} onChange={e=>filter('from',e.target.value)}/></label><label>{filters.period==='PREVIOUS'?'Payment to':'Reminder to'}<input type="date" value={filters.to} onChange={e=>filter('to',e.target.value)}/></label>
      <label>Account / bill search<input value={searchText} onChange={e=>setSearchText(e.target.value)} onKeyDown={e=>{if(e.key==='Enter'){e.preventDefault();showSearch();}}}/></label><button type="button" onClick={showSearch}>Show</button><button type="button" onClick={clearSearch}>Clear</button><button type="button" onClick={resetSearch}>Reset</button>
    </div>
    <p className="diary-search-result" role="status" aria-live="polite">{!hasResults?'Enter an account / bill or select a reminder date/month, then click Show.':loading?'Loading results…':data.rows.length+' bills shown'} · {filters.scope==='ALL'?'Local + Non-Local':filters.scope==='LOCAL'?'Local':'Non-Local'} · {filters.status==='ALL'?'All statuses':filters.status==='PENDING'?'Pending / Part paid':filters.status==='PAID'?'Paid history':'Deleted reminders'}{filters.search?' · Search: '+filters.search:''}{filters.from?' · From '+reportDate(filters.from):''}{filters.to?' · To '+reportDate(filters.to):''}</p>
    {!active&&<p className="diary-notice">Past financial year · read-only as of {data.as_of}. Unpaid balances continue in the active year. {!data.closed_years.some(row=>Number(row.year_start)===Number(filters.year))&&<button onClick={closeYear}>Close this completed year</button>}</p>}
    {error&&<p className="form-error" role="alert">{error}</p>}{message&&<p className="form-success" role="status">{message}</p>}
    <div className="diary-layout">{active&&!statementMode&&<section className="panel diary-entry"><h3>Add payment reminder</h3><p className="muted">Choose an existing ledger. This schedules its bill; it does not add another purchase entry.</p><form onSubmit={add}>
      <label>Account name (type 3 letters)<input value={form.account_name} onChange={e=>change('account_name',e.target.value)} maxLength={180} required autoComplete="off"/></label>
      {suggestions.length>0&&<div className="diary-suggestions" role="listbox">{suggestions.map(row=><button key={row.account_name} type="button" onClick={()=>{change('account_name',row.account_name);setSuggestions([]);}}>{row.account_name}</button>)}</div>}
      <label>Bill / invoice number (optional)<input value={form.bill_no} onChange={e=>change('bill_no',e.target.value)} maxLength={100} placeholder="Leave blank for automatic diary reference"/></label>
      <label>Bill amount<input type="number" min="0.01" step="0.01" value={form.amount} onChange={e=>change('amount',e.target.value)} required/></label>
      <label>Bill date<input type="date" max={todayIso()} value={form.bill_date} onChange={e=>change('bill_date',e.target.value)} required/></label>
      <label>Credit days<input type="number" min="0" max="3660" value={form.credit_days} onChange={e=>change('credit_days',e.target.value)} list="diary-credit-days"/><datalist id="diary-credit-days">{[0,7,15,28,30,40,60,90].map(days=><option key={days} value={days}/>)}</datalist></label>
      <label>Due date<input type="date" value={form.due_date} onChange={e=>change('due_date',e.target.value)} required/></label><label>Remarks<input value={form.notes} onChange={e=>change('notes',e.target.value)} maxLength={500}/></label>
      <button className="primary-button" disabled={busy}>{busy?'Saving…':'Add reminder'}</button>
    </form></section>}
    <>{statementMode?<PaymentStatement rows={data.statement||[]} summary={data.statement_summary||{}} onHistory={setHistory}/>:<section className="panel diary-table-panel"><div className="diary-table-wrap"><table><thead><tr><th>Account / bill</th><th>Bill date / Pay on</th><th>Amount</th><th>Payment date / details</th><th>Pending</th><th>Status / action</th></tr></thead><tbody>{groupDiaryBills(data.rows).map(group=><React.Fragment key={group.key}><DiaryGroupHeading group={group} columns={6}/>{group.rows.map(row=><tr key={row.id} className={row.pending_amount>0&&row.due_date<todayIso()?'diary-overdue':''}><td><strong>{row.account_name}</strong><small>{row.bill_no}</small>{row.carried_forward&&<small>Carried forward</small>}{row.notes&&<small>{row.notes}</small>}</td><td>{row.bill_date}<small><strong>Pay on {row.due_date}</strong></small>{row.reminder_date&&row.reminder_date!==row.due_date&&<small>Reminder {row.reminder_date} (before Sunday)</small>}</td><td>{amount(row.amount)}</td><td>{amount(row.paid_amount)}<small>Less {amount(row.discount_amount)}</small>{row.payments?.map(p=><div key={p.id}><strong>Paid on {p.payment_date}</strong><small>{p.payment_mode} · {amount(p.paid_amount)} · Less {amount(p.discount_amount)}</small><small>{p.bank_name} {p.reference_no}</small><small>{p.notes} · By {p.created_by}</small>{p.reversed_date&&<small>Reversed {p.reversed_date} · {p.reversal_reason}</small>}</div>)}</td><td><strong>{amount(row.pending_amount)}</strong></td><td><small>{row.status.replace('_',' ')}</small>{active&&!row.is_deleted&&row.pending_amount>0&&<button onClick={()=>setPayment(row)}>Record payment</button>}{active&&(row.is_deleted?<button onClick={()=>setEditing({row,mode:'RESTORE'})}>Restore</button>:<><button onClick={()=>setEditing({row,mode:'EDIT'})}>Edit</button><button onClick={()=>setEditing({row,mode:'DELETE'})}>Delete</button></>)}<button onClick={()=>setHistory(row)}>History</button></td></tr>)}</React.Fragment>)}</tbody></table></div>{!data.rows.length&&<p>{!hasResults?'Enter an account / bill or select a reminder date/month, then click Show.':loading?'Loading…':'No bills match these filters.'}</p>}</section>}</></div>
    {payment&&<DiaryPaymentDialog row={payment} onClose={()=>setPayment(null)} onSaved={()=>{setPayment(null);setMessage('Payment and discount posted to the selected ledger.');load();}}/>}
    {history&&<DiaryHistory row={history} onClose={()=>setHistory(null)} onChanged={load}/>}
    {editing&&<DiaryEditDialog row={editing.row} mode={editing.mode} onClose={()=>setEditing(null)} onSaved={()=>{setEditing(null);setMessage('Reminder updated. Ledger payments were retained.');load();}}/>}
  </div>;
}
