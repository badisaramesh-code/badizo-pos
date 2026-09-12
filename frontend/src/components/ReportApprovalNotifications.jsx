import React, { useEffect, useState } from 'react';
import { cancelPendingReportApprovals, decideReportApproval, fetchPendingReportApprovals } from '../api/client';
import './ReportApprovalNotifications.css';

export default function ReportApprovalNotifications({ currentUser }) {
  const [requests, setRequests] = useState([]);
  const [waiting, setWaiting] = useState(0);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  useEffect(() => {
    const listener = event => setWaiting(event.detail);
    window.addEventListener('report-approval-wait', listener);
    return () => {
      window.removeEventListener('report-approval-wait', listener);
      cancelPendingReportApprovals();
    };
  }, [currentUser]);
  useEffect(() => {
    if (currentUser?.role !== 'SERVER') return undefined;
    let active = true;
    let timer;
    async function poll() {
      try {
        const rows = await fetchPendingReportApprovals();
        if (active) { setRequests(rows); setError(''); }
      } catch (err) {
        if (active) setError(err.response?.data?.error || 'Cannot check report requests. Retrying...');
      } finally {
        if (active) timer = setTimeout(poll, 2000);
      }
    }
    poll();
    return () => { active = false; clearTimeout(timer); };
  }, [currentUser]);
  async function decide(id, approved) {
    setBusy(id);
    try {
      await decideReportApproval(id, approved);
      setRequests(rows => rows.filter(row => row.id !== id));
      setError('');
    } catch (err) { setError(err.response?.data?.error || 'Unable to send approval. Please retry.'); }
    finally { setBusy(''); }
  }
  if (currentUser?.role === 'COUNTER' && waiting > 0) return (
    <aside className="report-approval-notifications" aria-live="polite">
      <section className="report-approval-card">
        <strong>Waiting for server approval</strong>
        <p>Your sales report request was sent. View and print will continue after the server person presses OK.</p>
        <button className="secondary-button" onClick={cancelPendingReportApprovals}>Cancel request</button>
      </section>
    </aside>
  );
  if (currentUser?.role !== 'SERVER' || (!requests.length && !error)) return null;
  return (
    <aside className="report-approval-notifications" aria-label="Sales report approval requests" aria-live="polite">
      {error && <div className="alert-box">{error}</div>}
      {requests.map(row => (
        <section className="report-approval-card" key={row.id}>
          <h3>Sales report permission</h3>
          <p><strong>System {row.systemNo || '-'} / Counter {row.counterNo}</strong></p>
          <p>Person: {row.personName || row.username} ({row.username})</p>
          <p>{row.kind === 'counter-sale-slip' ? 'Counter Sale Slip' : `${row.reportType} Sale Report`}</p>
          <p>Dates: {row.from} to {row.to}</p>
          <p>Requested: {new Date(row.requestedAt).toLocaleString('en-IN')}</p>
          <p>Computer: {row.ip || '-'}</p>
          <p>Allow this counter to view and print?</p>
          <div className="report-approval-actions">
            <button className="primary-button" disabled={Boolean(busy)} onClick={() => decide(row.id, true)}>OK</button>
            <button className="secondary-button" disabled={Boolean(busy)} onClick={() => decide(row.id, false)}>Reject</button>
          </div>
        </section>
      ))}
    </aside>
  );
}
