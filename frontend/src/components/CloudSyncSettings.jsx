import React, { useEffect, useState } from 'react';
import { fetchCloudSyncSettings, saveCloudSyncSettings, getStoredUser } from '../api/client';

const defaults = { enabled: false, frequency: 'daily', dailyTime: '20:30', timezone: 'Asia/Kolkata' };
export default function CloudSyncSettings() {
  const [configuration, setConfiguration] = useState(defaults);
  const [status, setStatus] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState('');
  const mayEdit = getStoredUser()?.role === 'SERVER' && status?.editable === true;
  useEffect(() => {
    let mounted = true;
    fetchCloudSyncSettings().then(value => {
      if (mounted) { setStatus(value); setConfiguration(value.config); }
    }).catch(() => { if (mounted) setError('Cloud sync settings could not be loaded. Check the local server version and connection.'); })
      .finally(() => { if (mounted) setLoading(false); });
    return () => { mounted = false; };
  }, []);
  function change(key, value) { setConfiguration(current => ({ ...current, [key]: value })); setSaved(''); }
  async function save(event) {
    event.preventDefault(); setSaving(true); setError(''); setSaved('');
    try {
      const value = await saveCloudSyncSettings(configuration);
      setStatus(value); setConfiguration(value.config);
      setSaved(value.service.ready ? 'Cloud sync schedule saved.' : 'Schedule preference saved. Cloud sync is not active yet.');
    } catch (failure) { setError(failure.response?.data?.error || 'Unable to save cloud sync schedule.'); }
    finally { setSaving(false); }
  }
  return (
    <div className="panel system-folder-panel">
      <div className="panel-header green"><h2 className="panel-title">Cloud Sync</h2></div>
      <form className="panel-body form-stack" onSubmit={save}>
        <p>Update this shop’s cloud billing database with pending changes. Daily full backups to Google Drive continue separately.</p>
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
          <button className="secondary-button" type="submit" disabled={!mayEdit || saving || loading}>{saving ? 'Saving…' : 'Save Cloud Sync Schedule'}</button>
          <button className="secondary-button" type="button" disabled title="Available after the cloud sync service is connected">Update Cloud Now — not connected</button>
        </div>
        {error && <p role="alert">{error}</p>}
        {saved && <p role="status">{saved}</p>}
      </form>
    </div>
  );
}
