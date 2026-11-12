import React, { useEffect, useState } from 'react';
import api, { fetchCloudSyncSettings } from '../api/client';

function ist(value) {
  return value ? new Date(value).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }) : 'None reported';
}

export default function TransferAuditPanel() {
  const [report, setReport] = useState(null);
  const [refresh, setRefresh] = useState(0);
  const [expanded, setExpanded] = useState(false);
  useEffect(() => {
    let current = true;
    let timer;
    async function load() {
      const [sync, audit] = await Promise.allSettled([
        fetchCloudSyncSettings(), api.get('/cloud-sync/audit', { timeout: 10000 })
      ]);
      if (!current) return;
      setReport({ sync: sync.status === 'fulfilled' ? sync.value : null,
        audit: audit.status === 'fulfilled' ? audit.value.data : null });
      timer = setTimeout(load, 60000);
    }
    load();
    return () => { current = false; clearTimeout(timer); };
  }, [refresh]);
  const sync = report?.sync;
  const audit = report?.audit;
  const latest = audit?.rows.find(row => row.job === 'Daily backup');
  const fileDate = latest?.file?.match(/^badizo_daily_(\d{4}-\d{2}-\d{2})_(\d{2})-(\d{2})-(\d{2})/);
  const backupTime = fileDate ? Date.parse(fileDate[1] + 'T' + fileDate.slice(2).join(':') + '+05:30') : Date.parse(latest?.at);
  const stale = latest && Date.now() - backupTime > 25 * 3600000;
  return <section className="panel">
    <div className="panel-header green"><h2 className="panel-title">Daily Backup and Cloud Sync</h2>
      <button type="button" className="secondary-button" onClick={() => setRefresh(n => n + 1)}>Refresh status</button></div>
    <div className="panel-body">
      {!report ? <p>Checking status…</p> : <>
        <p><strong>Daily backup</strong> · {latest ? latest.status + ' · ' + ist(latest.at) + ' IST' :
          audit ? 'No recent backup result available' : 'Status unavailable'} {stale && <strong>· No recent daily backup</strong>}</p>
        <p><strong>Cloud database sync</strong> · {sync ? sync.service.ready ? sync.service.state : 'Not configured' : 'Status unavailable'}
          {sync && <> · Last success: {ist(sync.lastSuccessAt)} · Next run: {ist(sync.nextRunAt)} (IST)</>}</p>
        <button className="secondary-button" type="button" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>
          {expanded ? 'Hide audit history' : 'View 30-day audit history'}</button>
        {audit?.warnings.map(message => <p role="alert" key={message}>{message}</p>)}
        {expanded && (audit?.rows.length ? <div className="table-scroll"><table className="history-table">
          <thead><tr><th>Time (IST)</th><th>Job</th><th>Result</th><th>Trigger / file</th></tr></thead>
          <tbody>{audit.rows.map((row, i) => <tr key={row.at + i}><td>{ist(row.at)}</td><td>{row.job}</td>
            <td>{row.status}</td><td>{row.trigger || row.file || '—'}</td></tr>)}</tbody>
        </table></div> : <p>{audit ? 'No run records for this period.' : 'Audit history unavailable.'}</p>)}
      </>}
    </div>
  </section>;
}
