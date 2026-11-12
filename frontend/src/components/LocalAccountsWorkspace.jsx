import React, { useState } from 'react';
import LocalAccountsView from './LocalAccountsView';
import PaymentDiaryView from './PaymentDiaryView';

export default function LocalAccountsWorkspace({isActive=true,openDiary=false,onDiaryOpened}) {
  const [tab,setTab]=useState(openDiary?'diary':'ledgers');
  const selected=openDiary?'diary':tab;
  return <div className="local-accounts-workspace"><div className="local-scope-tabs diary-workspace-tabs" aria-label="Local / Non-Local sections">
    <button className={selected==='ledgers'?'active':''} onClick={()=>{setTab('ledgers');onDiaryOpened?.();}}>Ledgers</button>
    <button className={selected==='diary'?'active':''} onClick={()=>{setTab('diary');onDiaryOpened?.();}}>Payment Diary</button>
  </div>{selected==='ledgers'?<LocalAccountsView/>:<PaymentDiaryView isActive={isActive}/>}</div>;
}
