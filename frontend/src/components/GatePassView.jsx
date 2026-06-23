import React, { useEffect, useMemo, useState } from 'react';
import { fetchGatePassEntries, getStoredUser, saveGatePassEntry } from '../api/client';
import { formatDisplayDate, normalizeDateInput, todayIso } from '../utils/date';

const TRANSPORT_OPTIONS = [
  ['TRANSPORT', 'Transport'],
  ['AUTO', 'Auto'],
  ['TROLLEY', 'Trolley'],
  ['RIKSHA', 'Riksha'],
  ['HUMAN', 'Human'],
  ['OTHER', 'Other']
];

const STATUS_OPTIONS = [
  ['OPEN', 'Open'],
  ['VERIFIED', 'Verified'],
  ['CANCELLED', 'Cancelled']
];

function nowTime() {
  const now = new Date();
  return `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
}

function formatTimeAmPm(value) {
  const text = String(value || '').trim();
  if (!text) return '-';
  const match = text.match(/^([01]?\d|2[0-3]):([0-5]\d)/);
  if (!match) return text;
  const hour = Number(match[1]);
  const minute = match[2];
  const suffix = hour >= 12 ? 'PM' : 'AM';
  const displayHour = hour % 12 || 12;
  return `${String(displayHour).padStart(2, '0')}:${minute} ${suffix}`;
}

function formatTimeRange(startValue, endValue, startDisplay, endDisplay) {
  const start = startDisplay || formatTimeAmPm(startValue);
  const end = endDisplay || formatTimeAmPm(endValue);
  if (start === '-' && end === '-') return 'Not recorded';
  return `${start} to ${end}`;
}

function emptyForm(username = '') {
  return {
    id: null,
    pass_no: '',
    movement_type: 'IN',
    movement_date: todayIso(),
    movement_time: nowTime(),
    unload_start_time: '',
    unload_end_time: '',
    loading_start_time: '',
    loading_end_time: '',
    transport_mode: 'TRANSPORT',
    source_location: '',
    destination_location: '',
    party_name: '',
    party_phone: '',
    vehicle_no: '',
    driver_name: '',
    driver_phone: '',
    supervisor_name: '',
    supervisor_phone: '',
    security_person_name: username || '',
    security_person_phone: '',
    document_no: '',
    item_summary: '',
    package_count: '',
    remarks: '',
    status: 'OPEN'
  };
}

function movementLabel(value) {
  return value === 'OUT' ? 'Outward Stock' : 'Inward Stock';
}

export default function GatePassView() {
  const currentUser = getStoredUser();
  const [form, setForm] = useState(() => emptyForm(currentUser?.username));
  const [filters, setFilters] = useState({ from: todayIso(), to: todayIso(), movementType: '', status: '', search: '' });
  const [entries, setEntries] = useState([]);
  const [statusMessage, setStatusMessage] = useState('');
  const [errorMessage, setErrorMessage] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [isSaving, setIsSaving] = useState(false);

  const summary = useMemo(() => entries.reduce((acc, entry) => {
    if (entry.movement_type === 'OUT') acc.out += 1;
    else acc.in += 1;
    acc.packages += Number(entry.package_count || 0);
    return acc;
  }, { in: 0, out: 0, packages: 0 }), [entries]);

  useEffect(() => {
    loadEntries();
  }, []);

  function updateForm(field, value) {
    setForm((current) => ({ ...current, [field]: value }));
  }

  async function loadEntries(event) {
    event?.preventDefault?.();
    setIsLoading(true);
    setErrorMessage('');
    try {
      const data = await fetchGatePassEntries({
        from: normalizeDateInput(filters.from),
        to: normalizeDateInput(filters.to),
        movementType: filters.movementType,
        status: filters.status,
        search: filters.search
      });
      setEntries(Array.isArray(data.rows) ? data.rows : []);
    } catch (err) {
      setErrorMessage(err.response?.data?.error || 'Unable to load gate pass entries.');
    } finally {
      setIsLoading(false);
    }
  }

  function editEntry(entry) {
    setForm({
      ...emptyForm(currentUser?.username),
      ...entry,
      movement_date: normalizeDateInput(entry.movement_date),
      movement_time: String(entry.movement_time || nowTime()).slice(0, 5),
      unload_start_time: String(entry.unload_start_time || '').slice(0, 5),
      unload_end_time: String(entry.unload_end_time || '').slice(0, 5),
      loading_start_time: String(entry.loading_start_time || '').slice(0, 5),
      loading_end_time: String(entry.loading_end_time || '').slice(0, 5),
      package_count: entry.package_count ? String(entry.package_count) : ''
    });
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  async function handleSave(event) {
    event.preventDefault();
    setStatusMessage('');
    setErrorMessage('');

    if (!form.party_name.trim()) {
      setErrorMessage('Enter customer/supplier/party name.');
      return;
    }
    if (!form.supervisor_name.trim()) {
      setErrorMessage('Enter on duty supervisor name.');
      return;
    }
    if (!form.security_person_name.trim()) {
      setErrorMessage('Enter on duty security person name.');
      return;
    }

    setIsSaving(true);
    try {
      const saved = await saveGatePassEntry({
        ...form,
        movement_date: normalizeDateInput(form.movement_date),
        movement_time: form.movement_time || nowTime(),
        unload_start_time: form.movement_type === 'IN' ? form.unload_start_time : '',
        unload_end_time: form.movement_type === 'IN' ? form.unload_end_time : '',
        loading_start_time: form.movement_type === 'OUT' ? form.loading_start_time : '',
        loading_end_time: form.movement_type === 'OUT' ? form.loading_end_time : ''
      });
      setStatusMessage(`${saved.pass_no} saved successfully.`);
      setForm(emptyForm(currentUser?.username));
      await loadEntries();
    } catch (err) {
      setErrorMessage(err.response?.data?.error || 'Unable to save gate pass entry.');
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <div className="form-stack gate-pass-view">
      {errorMessage && <div className="alert-box">{errorMessage}</div>}
      {statusMessage && <div className="change-box">{statusMessage}</div>}

      <section className="panel">
        <div className="panel-header green">
          <h2 className="panel-title">Gate Pass Register</h2>
          <div className="gate-pass-summary">
            <span>Inward <strong>{summary.in}</strong></span>
            <span>Outward <strong>{summary.out}</strong></span>
            <span>Packages <strong>{summary.packages}</strong></span>
          </div>
        </div>
        <form className="panel-body form-stack" onSubmit={handleSave}>
          <div className="gate-pass-mode-row">
            <button
              type="button"
              className={`mode-pill inward ${form.movement_type === 'IN' ? 'active' : ''}`}
              onClick={() => updateForm('movement_type', 'IN')}
            >
              Inward Stock
            </button>
            <button
              type="button"
              className={`mode-pill outward ${form.movement_type === 'OUT' ? 'active' : ''}`}
              onClick={() => updateForm('movement_type', 'OUT')}
            >
              Outward Stock
            </button>
            {form.pass_no && <span className="gate-pass-number">{form.pass_no}</span>}
          </div>

          <div className="gate-pass-grid">
            <label><span className="field-label">Date</span><input className="field" type="date" value={normalizeDateInput(form.movement_date)} onChange={(event) => updateForm('movement_date', event.target.value)} /></label>
            <label><span className="field-label">Time</span><input className="field" type="time" value={form.movement_time} onChange={(event) => updateForm('movement_time', event.target.value)} /><span className="muted">{formatTimeAmPm(form.movement_time)}</span></label>
            {form.movement_type === 'IN' ? (
              <>
                <label><span className="field-label">Unload Start Time</span><input className="field" type="time" value={form.unload_start_time} onChange={(event) => updateForm('unload_start_time', event.target.value)} /><span className="muted">{formatTimeAmPm(form.unload_start_time)}</span></label>
                <label><span className="field-label">Unload End Time</span><input className="field" type="time" value={form.unload_end_time} onChange={(event) => updateForm('unload_end_time', event.target.value)} /><span className="muted">{formatTimeAmPm(form.unload_end_time)}</span></label>
              </>
            ) : (
              <>
                <label><span className="field-label">Loading Start Time</span><input className="field" type="time" value={form.loading_start_time} onChange={(event) => updateForm('loading_start_time', event.target.value)} /><span className="muted">{formatTimeAmPm(form.loading_start_time)}</span></label>
                <label><span className="field-label">Loading End Time</span><input className="field" type="time" value={form.loading_end_time} onChange={(event) => updateForm('loading_end_time', event.target.value)} /><span className="muted">{formatTimeAmPm(form.loading_end_time)}</span></label>
              </>
            )}
            <label><span className="field-label">Mode</span><select className="select" value={form.transport_mode} onChange={(event) => updateForm('transport_mode', event.target.value)}>{TRANSPORT_OPTIONS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
            <label><span className="field-label">Status</span><select className="select" value={form.status} onChange={(event) => updateForm('status', event.target.value)}>{STATUS_OPTIONS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
            <label><span className="field-label">From / Source</span><input className="field" value={form.source_location} onChange={(event) => updateForm('source_location', event.target.value)} placeholder="Supplier, godown, hub, store" /></label>
            <label><span className="field-label">To / Destination</span><input className="field" value={form.destination_location} onChange={(event) => updateForm('destination_location', event.target.value)} placeholder="Store, customer, godown, hub" /></label>
            <label><span className="field-label">Customer / Supplier / Party</span><input className="field" value={form.party_name} onChange={(event) => updateForm('party_name', event.target.value)} /></label>
            <label><span className="field-label">Party Phone</span><input className="field" value={form.party_phone} onChange={(event) => updateForm('party_phone', event.target.value)} /></label>
            <label><span className="field-label">Vehicle No</span><input className="field" value={form.vehicle_no} onChange={(event) => updateForm('vehicle_no', event.target.value.toUpperCase())} /></label>
            <label><span className="field-label">Driver Name</span><input className="field" value={form.driver_name} onChange={(event) => updateForm('driver_name', event.target.value)} /></label>
            <label><span className="field-label">Driver Phone</span><input className="field" value={form.driver_phone} onChange={(event) => updateForm('driver_phone', event.target.value)} /></label>
            <label><span className="field-label">Supervisor</span><input className="field" value={form.supervisor_name} onChange={(event) => updateForm('supervisor_name', event.target.value)} /></label>
            <label><span className="field-label">Supervisor Phone</span><input className="field" value={form.supervisor_phone} onChange={(event) => updateForm('supervisor_phone', event.target.value)} /></label>
            <label><span className="field-label">Security Person</span><input className="field" value={form.security_person_name} onChange={(event) => updateForm('security_person_name', event.target.value)} /></label>
            <label><span className="field-label">Security Phone</span><input className="field" value={form.security_person_phone} onChange={(event) => updateForm('security_person_phone', event.target.value)} /></label>
            <label><span className="field-label">Invoice / LR / DC No</span><input className="field" value={form.document_no} onChange={(event) => updateForm('document_no', event.target.value)} /></label>
            <label><span className="field-label">No. of Packages</span><input className="field" type="number" min="0" value={form.package_count} onChange={(event) => updateForm('package_count', event.target.value)} /></label>
            <label className="gate-pass-wide"><span className="field-label">Stock / Item Details</span><input className="field" value={form.item_summary} onChange={(event) => updateForm('item_summary', event.target.value)} placeholder="Short description of stock/items" /></label>
            <label className="gate-pass-wide"><span className="field-label">Remarks</span><input className="field" value={form.remarks} onChange={(event) => updateForm('remarks', event.target.value)} /></label>
          </div>

          <div className="report-action-row">
            <button className="secondary-button" type="button" onClick={() => setForm(emptyForm(currentUser?.username))}>Clear</button>
            <button className={`primary-button compact-primary gate-pass-save-button ${form.movement_type === 'OUT' ? 'outward' : 'inward'}`} type="submit" disabled={isSaving}>{isSaving ? 'Saving...' : `Save ${movementLabel(form.movement_type)}`}</button>
          </div>
        </form>
      </section>

      <section className="panel">
        <div className="panel-header green">
          <h2 className="panel-title">Inward / Outward Checking</h2>
          <form className="report-filter-row" onSubmit={loadEntries}>
            <input className="field report-date-input" type="date" value={normalizeDateInput(filters.from)} onChange={(event) => setFilters((current) => ({ ...current, from: event.target.value }))} />
            <input className="field report-date-input" type="date" value={normalizeDateInput(filters.to)} onChange={(event) => setFilters((current) => ({ ...current, to: event.target.value }))} />
            <select className="select" value={filters.movementType} onChange={(event) => setFilters((current) => ({ ...current, movementType: event.target.value }))}><option value="">All</option><option value="IN">Inward</option><option value="OUT">Outward</option></select>
            <select className="select" value={filters.status} onChange={(event) => setFilters((current) => ({ ...current, status: event.target.value }))}><option value="">All Status</option>{STATUS_OPTIONS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select>
            <input className="field" value={filters.search} onChange={(event) => setFilters((current) => ({ ...current, search: event.target.value }))} placeholder="Search party, phone, vehicle, document" />
            <button className="secondary-button" type="submit" disabled={isLoading}>{isLoading ? 'Loading...' : 'View'}</button>
          </form>
        </div>
        <div className="panel-body table-scroll">
          <table className="history-table gate-pass-table">
            <thead>
              <tr><th>Pass</th><th>Movement Date</th><th>Movement Time</th><th>Unload / Loading Time</th><th>Type</th><th>Mode</th><th>Party</th><th>Vehicle/Driver</th><th>Supervisor</th><th>Security</th><th>Stock</th><th>Added Date</th><th>Added Time</th><th>Edited Date</th><th>Edited Time</th><th>Status</th><th>Action</th></tr>
            </thead>
            <tbody>
              {entries.length === 0 ? (
                <tr><td colSpan="17">No gate pass entries for selected filters.</td></tr>
              ) : entries.map((entry) => (
                <tr key={entry.id}>
                  <td className="mono">{entry.pass_no}</td>
                  <td>{formatDisplayDate(entry.movement_date)}</td>
                  <td>{entry.movement_time_display || formatTimeAmPm(entry.movement_time)}</td>
                  <td>
                    {entry.movement_type === 'IN' ? (
                      <>
                        <strong>Unload</strong><br />
                        <span className="muted">{formatTimeRange(entry.unload_start_time, entry.unload_end_time, entry.unload_start_time_display, entry.unload_end_time_display)}</span>
                      </>
                    ) : (
                      <>
                        <strong>Loading</strong><br />
                        <span className="muted">{formatTimeRange(entry.loading_start_time, entry.loading_end_time, entry.loading_start_time_display, entry.loading_end_time_display)}</span>
                      </>
                    )}
                  </td>
                  <td><span className={`movement-badge ${entry.movement_type === 'OUT' ? 'outward' : 'inward'}`}>{movementLabel(entry.movement_type)}</span></td>
                  <td>{entry.transport_mode}</td>
                  <td>{entry.party_name}<br /><span className="muted">{entry.party_phone}</span></td>
                  <td>{entry.vehicle_no || '-'}<br /><span className="muted">{entry.driver_name} {entry.driver_phone}</span></td>
                  <td>{entry.supervisor_name}<br /><span className="muted">{entry.supervisor_phone}</span></td>
                  <td>{entry.security_person_name}<br /><span className="muted">{entry.security_person_phone}</span></td>
                  <td>{entry.item_summary || '-'}<br /><span className="muted">Packages: {entry.package_count || 0}</span></td>
                  <td>{formatDisplayDate(entry.added_date)}</td>
                  <td>{entry.added_time || '-'}</td>
                  <td>{formatDisplayDate(entry.edited_date)}</td>
                  <td>{entry.edited_time || '-'}</td>
                  <td>{entry.status}</td>
                  <td><button className="secondary-button" type="button" onClick={() => editEntry(entry)}>Edit</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
