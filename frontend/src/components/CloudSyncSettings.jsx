import React, { useEffect, useRef, useState } from 'react';
import { fetchCloudSyncSettings, saveCloudSyncSettings, requestCloudSyncNow, getStoredUser } from '../api/client';
import { cloudSyncProgress } from '../utils/cloudSyncProgress';

const defaults = { enabled: false, frequency: 'daily', dailyTime: '20:30', timezone: 'Asia/Kolkata' };
export default function CloudSyncSettings() {
  const [configuration, setConfiguration] = useState(defaults);
  const [status, setStatus] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [requesting, setRequesting] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState('');
  const [refreshError, setRefreshError] = useState('');
  const mutation = useRef(false);
  const revision = useRef(0);
  const progress = cloudSyncProgress(status, requesting, refreshError);
  const mayEdit = getStoredUser()?.role === 'SERVER' && status?.editable === true;
  useEffect(() => {
    let mounted = true;
    let timer;
    let initialized = false;
    async function refresh() {
      const version = revision.current;
      try {
        if (!mutation.current) {
          const value = await fetchCloudSyncSettings();
          if (mounted && version === revision.current) {
            setStatus(value); setRefreshError('');
            if (!initialized) { setConfiguration(value.config); initialized = true; }
          }
        }
      } catch (_) {
        if (mounted && version === revision.current) setRefreshError('Unable to refresh sync status. Billing can continue; check the connection.');
      } finally {
        if (mounted) { setLoading(false); timer = setTimeout(refresh, 5000); }
      }
    }
    refresh();
    return () => { mounted = false; clearTimeout(timer); };
  }, []);
  async function updateNow() {
    setRequesting(true); setError(''); setSaved('');
    mutation.current = true; revision.current += 1;
    try { setStatus(await requestCloudSyncNow()); setRefreshError(''); }
    catch(failure) { setError(failure.response?.data?.error || 'Unable to confirm the sync request. Status will refresh automatically.'); setRefreshError('Checking sync status after an unsuccessful request.'); }
    finally { mutation.current = false; setRequesting(false); }
  }
  function change(key, value) { setConfiguration(current => ({ ...current, [key]: value })); setSaved(''); }
  async function save(event) {
    event.preventDefault(); setSaving(true); setError(''); setSaved('');
    mutation.current = true; revision.current += 1;
    try {
      const value = await saveCloudSyncSettings(configuration);
      setStatus(value); setConfiguration(value.config); setRefreshError('');
      setSaved(value.service.ready ? 'Cloud sync schedule saved.' : 'Schedule preference saved. Cloud sync is not active yet.');
    } catch (failure) { setError(failure.response?.data?.error || 'Unable to save cloud sync schedule.'); }
    finally { mutation.current = false; setSaving(false); }
  }
  return (
    <div className="panel system-folder-panel">
      <div className="panel-header green"><h2 className="panel-title">Cloud Sync</h2></div>
      <form className="panel-body form-stack" onSubmit={save}>
        <p>{status?.service.direction === 'two-way' ? 'Bring pending cloud changes into this local server and send local changes to the cloud.' : 'Update this shop’s cloud billing database with pending changes.'} Daily full backups to Google Drive continue separately.</p>
        {loading && <p className="muted" role="status">Loading cloud sync settings…</p>}
        {status && <div className="change-box" role="status"><strong>{status.service.ready ? 'Cloud connection configured' : 'Cloud sync not configured'}</strong><span>{status.message}</span></div>}
        <label><span className="field-label">Sync frequency</span>
          <select className="select" value={configuration.frequency} disabled={!mayEdit || saving} onChange={event => change('frequency', event.target.value)}>
            <option value="daily">Daily</option><option value="hourly">Hourly</option>
          </select>
        </label>
        {configuration.frequency === 'daily' ? <label><span className="field-label">Daily sync time — IST</span>
          <input className="field" type="time" required value={configuration.dailyTime} disabled={!mayEdit || saving} onChange={event => change('dailyTime', event.target.value)} />
        </label> : <p className="muted">Hourly sync runs at the start of each hour in IST once connected and enabled.</p>}
        <label><input type="checkbox" checked={configuration.enabled} disabled={!mayEdit || saving || !status?.service.ready} onChange={event => change('enabled', event.target.checked)} /> Enable automatic cloud sync</label>
        {!status?.service.ready && <p className="muted">Automatic sync can be enabled after the cloud sync connection is configured.</p>}
        {status && <p className="muted">Last successful sync: {status.lastSuccessAt ? new Date(status.lastSuccessAt).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }) : 'Not reported'}. Next run: {status.nextRunAt ? new Date(status.nextRunAt).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }) : 'Not scheduled'}.</p>}
        {getStoredUser()?.role !== 'SERVER' && <p className="muted">A Server user can change this schedule.</p>}
        <div className="settings-action-row">
          <button className="secondary-button" type="submit" disabled={!mayEdit || saving || requesting || loading}>{saving ? 'Saving…' : 'Save Cloud Sync Schedule'}</button>
          <button className="secondary-button" type="button" onClick={updateNow} disabled={!mayEdit || !status?.service.ready || requesting || saving || status?.manualPending || status?.service.state === 'running'}>{requesting ? 'Queuing…' : ['running', 'pending'].includes(status?.service.state) ? 'Syncing…' : status?.manualPending ? 'Sync queued' : status?.service.direction === 'two-way' ? 'Sync Local and Cloud' : 'Update Cloud Now'}</button>
        </div>
        {!loading && <div aria-live="polite" aria-atomic="true">
          <strong>{progress.label}</strong>
          <progress max={1} value={progress.value} aria-label={progress.label} style={{ display: 'block', width: '100%', height: 20, marginTop: 8 }} />
          <p className="muted">{progress.detail}</p>
        </div>}
        {refreshError && <p role="status">{refreshError}</p>}
        {error && <p role="alert">{error}</p>}
        {saved && <p role="status">{saved}</p>}
      </form>
    </div>
  );
}
