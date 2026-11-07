import React,{useEffect,useState} from 'react';
import api from '../api/client';
const labels={update:'Update software',restart:'Restart POS',repair:'Reinstall desktop app'};
export default function ShopMaintenance() {
  const [info,setInfo]=useState(null),[error,setError]=useState(''),[busy,setBusy]=useState(false);
  const pending=['queued','running'].includes(info?.job?.state);
  useEffect(()=>{
    let active=true;
    async function check() {
      try {const {data}=await api.get('/shop-maintenance');if(active){setInfo(data);setError('');}}
      catch(e){if(active)setError(e.response?.data?.error||'Shop maintenance is unavailable.');}
    }
    check();
    const timer=pending?setInterval(check,10000):null;
    return ()=>{active=false;clearInterval(timer);};
  },[pending]);
  async function request(action){
    if(!window.confirm(labels[action]+' on this shop server? Finish open bills and close the counters first.')) return;
    setBusy(true);
    try{const {data}=await api.post('/shop-maintenance',{action});setInfo(v=>({...v,job:data.job}));setError('');}
    catch(e){setError(e.response?.data?.error||'Request failed.');}finally{setBusy(false);}
  }
  return <section className="panel"><div className="panel-header"><h2 className="panel-title">Software maintenance</h2></div>
    <div className="panel-body">{error && <p role="alert">{error}</p>}
    {info?.configured===false && <p>Enroll this server in shop management to enable software updates.</p>}
    {info?.configured && <><p>Approved release · {info.target?.slice(0,12)||'Not set'}</p>
    {info.actions?.map(action=><button type="button" className="secondary-button" key={action}
      disabled={busy||pending||info.job?.state==='unknown'||(action==='update'&&!info.target)} onClick={()=>request(action)}>{labels[action]}</button>)}
    {!info.actions?.length && <p>The Windows maintenance agent has not reported its capabilities.</p>}
    {info.job && <p role="status">{labels[info.job.action]} · {info.job.state}</p>}</>}</div></section>;
}
