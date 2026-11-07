import React,{useEffect,useState} from 'react';
import api from '../api/client';

export default function CloudSoftwareUpdate() {
  const [open,setOpen]=useState(()=>window.location.hash==='#software-versions');
  const [selected,setSelected]=useState('');
  const [info,setInfo]=useState(null);
  const [notice,setNotice]=useState('');
  const [waiting,setWaiting]=useState(()=>sessionStorage.getItem('cloudUpdateTarget'));
  useEffect(()=>{
    let active=true, timer;
    async function refresh() {
      try {
        const {data}=await api.get('/cloud-software');
        if (!active) return;
        setInfo(data);
        if (waiting && data.state.commit===waiting && ['ready','failed','rolled-back','inspect'].includes(data.state.phase)) {
          sessionStorage.removeItem('cloudUpdateTarget');
          setWaiting(null);
          if(data.state.phase==='ready' && data.running===waiting) window.location.reload();
        }
      } catch {if(active)setInfo(null);}
      if(active)timer=setTimeout(refresh,waiting?4000:120000);
    }
    refresh();
    return ()=>{active=false;clearTimeout(timer);};
  },[waiting]);
  async function install(commit){
    if (!window.confirm('Install '+(info.versions.find(v=>v.commit===commit)?.name || commit.slice(0,12))+' on the cloud standby and restart it?')) return;
    setNotice('');
    try {
      await api.post('/cloud-software',{commit});
      sessionStorage.setItem('cloudUpdateTarget',commit);
      setWaiting(commit);
    } catch(error){setNotice(error.response?.data?.error || 'Check cloud update status.');}
  }
  const available=info?.release && info.release.commit!==info.running;
  return <span role="status">
    {waiting ? 'Updating cloud…' : available && info.standby ?
      <button className="tab-button" onClick={()=>install(info.release.commit)} title={info.release.name}>↻ Update cloud software</button> :
      info?.lookupFailed ? 'Cloud update check unavailable' :
      !info ? 'Checking cloud updates…' : !info.standby ? 'Cloud updates paused' :
      info.release ? 'Cloud software up to date' : 'No cloud release available'}
    {['failed','rolled-back','inspect'].includes(info?.state.phase) && ' · '+info.state.message}
    {notice && ' · '+notice}
  </span>;
}
