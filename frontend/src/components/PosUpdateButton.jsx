import React, { useEffect, useState } from 'react';
import api from '../api/client';

const receiptKey = 'badizo-pos-update';
const commitPattern = /^[a-f0-9]{40}$/;

export default function PosUpdateButton() {
  const [info, setInfo] = useState(null);
  const [pending, setPending] = useState(() => sessionStorage.getItem(receiptKey));
  const [message, setMessage] = useState('');

  useEffect(() => {
    let active = true;
    let timer;
    async function check() {
      try {
        const {data} = await api.get('/shop-maintenance');
        if (!active) return;
        setInfo(data);
        if (pending && data.job?.target !== pending &&
            Date.now() - Number(sessionStorage.getItem(receiptKey + '-time')) > 180000) {
          sessionStorage.removeItem(receiptKey);
          setPending(null);
          setMessage('The server has no matching update request. Check Software maintenance in System.');
        }
        if (pending && data.job?.target === pending && ['rollback','update'].includes(data.job.action)) {
          if (data.job.state === 'succeeded' && data.runningCommit === pending) {
            sessionStorage.removeItem(receiptKey);
            setPending(null);
            const reopened = await window.badizoDesktop?.reopenUpdatedPos?.().catch(() => false);
            if (!reopened) window.location.reload();
            return;
          }
          if (['failed','unknown','expired'].includes(data.job.state)) {
            sessionStorage.removeItem(receiptKey);
            setPending(null);
            setMessage('Update ' + data.job.state + '. Check Software maintenance in System.');
          }
        }
      } catch { /* The service briefly goes offline during installation. */ }
      if (active) timer = setTimeout(check, pending ? 5000 : 120000);
    }
    check();
    return () => { active = false; clearTimeout(timer); };
  }, [pending]);

  useEffect(() => {
    function watch(event) {
      if (!commitPattern.test(event.detail)) return;
      sessionStorage.setItem(receiptKey,event.detail);
      sessionStorage.setItem(receiptKey+'-time',String(Date.now()));
      setPending(event.detail);
    }
    window.addEventListener('badizo-version-switch',watch);
    return ()=>window.removeEventListener('badizo-version-switch',watch);
  },[]);
  async function install() {
    if (!window.confirm('Finish open bills at every counter before continuing. Install the shop update and reopen this POS?')) return;
    const target = info.target;
    sessionStorage.setItem(receiptKey,target);
    sessionStorage.setItem(receiptKey + '-time', String(Date.now()));
    setPending(target);
    setMessage('');
    try {
      await api.post('/shop-maintenance',{action:'update',target});
    } catch (error) {
      if (error.response && error.response.status < 500) {
        sessionStorage.removeItem(receiptKey);
        setPending(null);
      }
      setMessage('Check the update status in System → Software maintenance.');
    }
  }

  const available = info?.actions?.includes('update') && commitPattern.test(info.runningCommit) &&
    commitPattern.test(info.target) && info.runningCommit !== info.target;
  const busy = ['queued','running','unknown'].includes(info?.job?.state);
  return <>
    {(available || pending) && <button type="button" className="tab-button pos-update" onClick={install} disabled={!!pending || busy}>
      <span aria-hidden="true" className="pos-update-icon">↻</span>
      {pending ? 'Updating…' : 'Update available'}
    </button>}
    {message && <span role="status">{message}</span>}
  </>;
}
