import React, { useEffect, useMemo, useState } from 'react';
import {
  deleteHospitalityContent,
  fetchHospitalityBookings,
  fetchHospitalityContent,
  fetchHospitalityStockMovements,
  fetchHospitalitySummary,
  fetchHospitalityTasks,
  saveHospitalityBooking,
  saveHospitalityContent,
  saveHospitalityStockMovement,
  saveHospitalityTask
} from '../api/client';

const today = () => new Date().toISOString().slice(0, 10);

const contentBlank = {
  id: null,
  content_type: 'GALLERY',
  title: '',
  description: '',
  image_url: '',
  price: '',
  unit_label: '',
  capacity: '',
  display_order: 0,
  is_active: true
};

const bookingBlank = {
  id: null,
  booking_type: 'ROOM',
  booking_date: today(),
  time_slot: '',
  customer_name: '',
  customer_phone: '',
  customer_address: '',
  item_title: '',
  guest_count: '',
  total_amount: '',
  advance_amount: '',
  payment_mode: 'Cash',
  status: 'ENQUIRY',
  notes: ''
};

const taskBlank = {
  id: null,
  task_date: today(),
  area: 'RECEPTION',
  title: '',
  assigned_to: '',
  amount: '',
  status: 'OPEN',
  notes: ''
};

const stockBlank = {
  id: null,
  movement_date: today(),
  direction: 'INWARD',
  item_name: '',
  supplier_name: '',
  quantity: '',
  unit_label: '',
  amount: '',
  purpose: '',
  notes: ''
};

const contentTabs = [
  ['GALLERY', 'Gallery'],
  ['FOOD', 'Food Menu'],
  ['ROOM', 'Room Rent'],
  ['BANQUET', 'Banquet Rent']
];

const bookingTypes = ['ALL', 'ROOM', 'FOOD', 'BANQUET'];
const bookingStatuses = ['ENQUIRY', 'ADVANCE', 'CONFIRMED', 'CHECKED_IN', 'COMPLETED', 'CANCELLED'];
const taskAreas = ['RECEPTION', 'KITCHEN', 'MANAGER', 'SERVER', 'SUPPLIER', 'STORE', 'HOUSEKEEPING', 'LAUNDRY', 'ACCOUNTS'];
const taskStatuses = ['OPEN', 'IN_PROGRESS', 'DONE', 'CANCELLED'];

function formatMoney(value) {
  return Number(value || 0).toLocaleString('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 });
}

function Field({ label, children }) {
  return (
    <label>
      <span className="field-label">{label}</span>
      {children}
    </label>
  );
}

export default function HospitalityView() {
  const [activeContentType, setActiveContentType] = useState('GALLERY');
  const [summary, setSummary] = useState(null);
  const [contentRows, setContentRows] = useState([]);
  const [bookings, setBookings] = useState([]);
  const [tasks, setTasks] = useState([]);
  const [stockRows, setStockRows] = useState([]);
  const [contentForm, setContentForm] = useState(contentBlank);
  const [bookingForm, setBookingForm] = useState(bookingBlank);
  const [taskForm, setTaskForm] = useState(taskBlank);
  const [stockForm, setStockForm] = useState(stockBlank);
  const [filters, setFilters] = useState({ from: today(), to: today(), bookingType: 'ALL' });
  const [statusMessage, setStatusMessage] = useState('');
  const [errorMessage, setErrorMessage] = useState('');

  useEffect(() => {
    loadSummary();
  }, []);

  useEffect(() => {
    loadContent(activeContentType);
  }, [activeContentType]);

  useEffect(() => {
    loadWork();
  }, [filters.from, filters.to, filters.bookingType]);

  async function loadSummary() {
    try {
      setSummary(await fetchHospitalitySummary());
    } catch (err) {
      setErrorMessage('Unable to load hospitality dashboard.');
    }
  }

  async function loadContent(type = activeContentType) {
    try {
      setContentRows(await fetchHospitalityContent(type));
    } catch (err) {
      setContentRows([]);
    }
  }

  async function loadWork() {
    try {
      const [bookingRows, taskRows, movementRows] = await Promise.all([
        fetchHospitalityBookings({ from: filters.from, to: filters.to, type: filters.bookingType }),
        fetchHospitalityTasks({ from: filters.from, to: filters.to }),
        fetchHospitalityStockMovements({ from: filters.from, to: filters.to })
      ]);
      setBookings(bookingRows);
      setTasks(taskRows);
      setStockRows(movementRows);
    } catch (err) {
      setErrorMessage('Unable to load hospitality operations.');
    }
  }

  function resetMessages() {
    setStatusMessage('');
    setErrorMessage('');
  }

  async function handleContentSave(event) {
    event.preventDefault();
    resetMessages();
    try {
      await saveHospitalityContent({ ...contentForm, content_type: activeContentType });
      setContentForm({ ...contentBlank, content_type: activeContentType });
      setStatusMessage('Website/menu item saved.');
      await Promise.all([loadContent(activeContentType), loadSummary()]);
    } catch (err) {
      setErrorMessage(err.response?.data?.error || 'Unable to save website item.');
    }
  }

  async function handleContentDelete(row) {
    if (!window.confirm(`Delete ${row.title}?`)) return;
    resetMessages();
    try {
      await deleteHospitalityContent(row.id);
      setStatusMessage('Item deleted.');
      await loadContent(activeContentType);
    } catch (err) {
      setErrorMessage(err.response?.data?.error || 'Unable to delete item.');
    }
  }

  async function handleBookingSave(event) {
    event.preventDefault();
    resetMessages();
    try {
      await saveHospitalityBooking(bookingForm);
      setBookingForm(bookingBlank);
      setStatusMessage('Booking saved.');
      await Promise.all([loadWork(), loadSummary()]);
    } catch (err) {
      setErrorMessage(err.response?.data?.error || 'Unable to save booking.');
    }
  }

  async function handleTaskSave(event) {
    event.preventDefault();
    resetMessages();
    try {
      await saveHospitalityTask(taskForm);
      setTaskForm(taskBlank);
      setStatusMessage('Operations task saved.');
      await Promise.all([loadWork(), loadSummary()]);
    } catch (err) {
      setErrorMessage(err.response?.data?.error || 'Unable to save task.');
    }
  }

  async function handleStockSave(event) {
    event.preventDefault();
    resetMessages();
    try {
      await saveHospitalityStockMovement(stockForm);
      setStockForm(stockBlank);
      setStatusMessage('Store movement saved.');
      await Promise.all([loadWork(), loadSummary()]);
    } catch (err) {
      setErrorMessage(err.response?.data?.error || 'Unable to save stock movement.');
    }
  }

  const cards = useMemo(() => {
    const bookingsSummary = summary?.bookings || {};
    const taskSummary = summary?.tasks || {};
    const stockSummary = summary?.stock || {};
    return [
      ['Today Bookings', bookingsSummary.today_bookings || 0],
      ['Advance Total', formatMoney(bookingsSummary.advance_total)],
      ['Balance Pending', formatMoney(bookingsSummary.balance_total)],
      ['Pending Ops', taskSummary.pending_tasks || 0],
      ['Today Inward', formatMoney(stockSummary.inward_amount)],
      ['Today Outward', formatMoney(stockSummary.outward_amount)]
    ];
  }, [summary]);

  return (
    <div className="hospitality-view">
      <section className="hospitality-hero panel">
        <div>
          <span className="hospitality-eyebrow">ANVI GRAND Hospitality Platform</span>
          <h1>ANVI GRAND + CHIGURU Operations</h1>
          <p>Near Benz Circle, Eluru Road, Vijayawada, Krishna Dist, Andhra Pradesh. Phone: 7569494949</p>
        </div>
        <a className="secondary-button hospitality-preview-link" href="/anvi-grand" target="_blank" rel="noreferrer">Open Website Preview</a>
      </section>

      {(statusMessage || errorMessage) && (
        <div className={`hospitality-message ${errorMessage ? 'danger' : 'success'}`}>
          {errorMessage || statusMessage}
        </div>
      )}

      <section className="hospitality-kpi-grid">
        {cards.map(([label, value]) => (
          <div className="panel hospitality-kpi" key={label}>
            <span>{label}</span>
            <strong>{value}</strong>
          </div>
        ))}
      </section>

      <section className="panel">
        <div className="panel-header green">
          <h2 className="panel-title">Website CMS: Gallery, Food Menu, Room Rent, Banquet Rent</h2>
        </div>
        <div className="panel-body hospitality-section-body">
          <div className="hospitality-tabs">
            {contentTabs.map(([key, label]) => (
              <button
                key={key}
                className={`mode-pill ${activeContentType === key ? 'active' : ''}`}
                type="button"
                onClick={() => {
                  setActiveContentType(key);
                  setContentForm({ ...contentBlank, content_type: key });
                }}
              >
                {label}
              </button>
            ))}
          </div>
          <form className="hospitality-form-grid" onSubmit={handleContentSave}>
            <Field label="Title / Item Name">
              <input className="field" value={contentForm.title} onChange={(event) => setContentForm((current) => ({ ...current, title: event.target.value }))} required />
            </Field>
            <Field label="Price / Rent">
              <input className="field" type="number" value={contentForm.price} onChange={(event) => setContentForm((current) => ({ ...current, price: event.target.value }))} />
            </Field>
            <Field label="Unit">
              <input className="field" value={contentForm.unit_label} onChange={(event) => setContentForm((current) => ({ ...current, unit_label: event.target.value }))} placeholder="plate, night, event" />
            </Field>
            <Field label="Capacity">
              <input className="field" type="number" value={contentForm.capacity || ''} onChange={(event) => setContentForm((current) => ({ ...current, capacity: event.target.value }))} />
            </Field>
            <Field label="Image URL / Photo Path">
              <input className="field" value={contentForm.image_url} onChange={(event) => setContentForm((current) => ({ ...current, image_url: event.target.value }))} placeholder="https://... or local served image URL" />
              <span className="field-help">Blank ga vadilite default rich photo vastundi. Real hotel photo add cheyyali ante URL/path paste cheyyandi.</span>
            </Field>
            <Field label="Display Order">
              <input className="field" type="number" value={contentForm.display_order} onChange={(event) => setContentForm((current) => ({ ...current, display_order: event.target.value }))} />
            </Field>
            <label className="change-box hospitality-checkbox">
              <input type="checkbox" checked={Boolean(contentForm.is_active)} onChange={(event) => setContentForm((current) => ({ ...current, is_active: event.target.checked }))} />
              Active on website
            </label>
            <Field label="Description">
              <textarea className="field" rows="2" value={contentForm.description} onChange={(event) => setContentForm((current) => ({ ...current, description: event.target.value }))} />
            </Field>
            <button className="primary-button compact-primary" type="submit">{contentForm.id ? 'Update Item' : 'Add Item'}</button>
            <button className="secondary-button" type="button" onClick={() => setContentForm({ ...contentBlank, content_type: activeContentType })}>Clear</button>
          </form>
          <div className="table-scroll">
            <table className="history-table hospitality-table">
              <thead><tr><th>Title</th><th>Price</th><th>Capacity</th><th>Status</th><th>Image</th><th>Actions</th></tr></thead>
              <tbody>
                {contentRows.length === 0 ? (
                  <tr><td colSpan="6">No records yet.</td></tr>
                ) : contentRows.map((row) => (
                  <tr key={row.id}>
                    <td><strong>{row.title}</strong><span className="muted">{row.description}</span></td>
                    <td>{formatMoney(row.price)} {row.unit_label ? `/ ${row.unit_label}` : ''}</td>
                    <td>{row.capacity || '-'}</td>
                    <td><span className={`status-chip ${row.is_active ? 'success' : 'muted'}`}>{row.is_active ? 'Active' : 'Hidden'}</span></td>
                    <td className="mono">{row.image_url || '-'}</td>
                    <td><div className="table-actions"><button className="secondary-button" type="button" onClick={() => setContentForm(row)}>Edit</button><button className="danger-button" type="button" onClick={() => handleContentDelete(row)}>Delete</button></div></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </section>

      <section className="panel">
        <div className="panel-header green">
          <h2 className="panel-title">Reception Bookings: Rooms, Food, Banquet</h2>
        </div>
        <div className="panel-body hospitality-section-body">
          <form className="hospitality-form-grid" onSubmit={handleBookingSave}>
            <Field label="Type"><select className="select" value={bookingForm.booking_type} onChange={(event) => setBookingForm((current) => ({ ...current, booking_type: event.target.value }))}>{bookingTypes.filter((type) => type !== 'ALL').map((type) => <option key={type} value={type}>{type}</option>)}</select></Field>
            <Field label="Date"><input className="field" type="date" value={bookingForm.booking_date} onChange={(event) => setBookingForm((current) => ({ ...current, booking_date: event.target.value }))} /></Field>
            <Field label="Time Slot"><input className="field" value={bookingForm.time_slot} onChange={(event) => setBookingForm((current) => ({ ...current, time_slot: event.target.value }))} placeholder="Lunch / 7 PM / Check-in" /></Field>
            <Field label="Customer Name"><input className="field" value={bookingForm.customer_name} onChange={(event) => setBookingForm((current) => ({ ...current, customer_name: event.target.value }))} required /></Field>
            <Field label="Phone"><input className="field" value={bookingForm.customer_phone} onChange={(event) => setBookingForm((current) => ({ ...current, customer_phone: event.target.value }))} required /></Field>
            <Field label="Item / Room / Hall"><input className="field" value={bookingForm.item_title} onChange={(event) => setBookingForm((current) => ({ ...current, item_title: event.target.value }))} /></Field>
            <Field label="Persons"><input className="field" type="number" value={bookingForm.guest_count} onChange={(event) => setBookingForm((current) => ({ ...current, guest_count: event.target.value }))} /></Field>
            <Field label="Total"><input className="field" type="number" value={bookingForm.total_amount} onChange={(event) => setBookingForm((current) => ({ ...current, total_amount: event.target.value }))} /></Field>
            <Field label="Advance"><input className="field" type="number" value={bookingForm.advance_amount} onChange={(event) => setBookingForm((current) => ({ ...current, advance_amount: event.target.value }))} /></Field>
            <Field label="Status"><select className="select" value={bookingForm.status} onChange={(event) => setBookingForm((current) => ({ ...current, status: event.target.value }))}>{bookingStatuses.map((status) => <option key={status} value={status}>{status}</option>)}</select></Field>
            <Field label="Address"><textarea className="field" rows="2" value={bookingForm.customer_address} onChange={(event) => setBookingForm((current) => ({ ...current, customer_address: event.target.value }))} /></Field>
            <Field label="Notes"><textarea className="field" rows="2" value={bookingForm.notes} onChange={(event) => setBookingForm((current) => ({ ...current, notes: event.target.value }))} /></Field>
            <button className="primary-button compact-primary" type="submit">{bookingForm.id ? 'Update Booking' : 'Save Booking'}</button>
            <button className="secondary-button" type="button" onClick={() => setBookingForm(bookingBlank)}>Clear</button>
          </form>
          <div className="hospitality-filter-row">
            <input className="field" type="date" value={filters.from} onChange={(event) => setFilters((current) => ({ ...current, from: event.target.value }))} />
            <input className="field" type="date" value={filters.to} onChange={(event) => setFilters((current) => ({ ...current, to: event.target.value }))} />
            <select className="select" value={filters.bookingType} onChange={(event) => setFilters((current) => ({ ...current, bookingType: event.target.value }))}>{bookingTypes.map((type) => <option key={type} value={type}>{type}</option>)}</select>
          </div>
          <div className="table-scroll">
            <table className="history-table hospitality-table">
              <thead><tr><th>Date</th><th>Type</th><th>Customer</th><th>Item</th><th>Total</th><th>Advance</th><th>Balance</th><th>Status</th><th>Actions</th></tr></thead>
              <tbody>
                {bookings.length === 0 ? <tr><td colSpan="9">No bookings in selected dates.</td></tr> : bookings.map((row) => (
                  <tr key={row.id}>
                    <td>{row.booking_date}<span className="muted">{row.time_slot || ''}</span></td>
                    <td>{row.booking_type}</td>
                    <td><strong>{row.customer_name}</strong><span className="muted">{row.customer_phone}</span></td>
                    <td>{row.item_title || '-'}</td>
                    <td>{formatMoney(row.total_amount)}</td>
                    <td>{formatMoney(row.advance_amount)}</td>
                    <td>{formatMoney(row.balance_amount)}</td>
                    <td><span className="status-chip info">{row.status}</span></td>
                    <td><button className="secondary-button" type="button" onClick={() => setBookingForm(row)}>Edit</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </section>

      <section className="hospitality-two-column">
        <div className="panel">
          <div className="panel-header green"><h2 className="panel-title">Operations Tasks</h2></div>
          <div className="panel-body hospitality-section-body">
            <form className="hospitality-form-grid compact" onSubmit={handleTaskSave}>
              <Field label="Date"><input className="field" type="date" value={taskForm.task_date} onChange={(event) => setTaskForm((current) => ({ ...current, task_date: event.target.value }))} /></Field>
              <Field label="Section"><select className="select" value={taskForm.area} onChange={(event) => setTaskForm((current) => ({ ...current, area: event.target.value }))}>{taskAreas.map((area) => <option key={area} value={area}>{area}</option>)}</select></Field>
              <Field label="Task"><input className="field" value={taskForm.title} onChange={(event) => setTaskForm((current) => ({ ...current, title: event.target.value }))} required /></Field>
              <Field label="Assigned To"><input className="field" value={taskForm.assigned_to} onChange={(event) => setTaskForm((current) => ({ ...current, assigned_to: event.target.value }))} /></Field>
              <Field label="Amount"><input className="field" type="number" value={taskForm.amount} onChange={(event) => setTaskForm((current) => ({ ...current, amount: event.target.value }))} /></Field>
              <Field label="Status"><select className="select" value={taskForm.status} onChange={(event) => setTaskForm((current) => ({ ...current, status: event.target.value }))}>{taskStatuses.map((status) => <option key={status} value={status}>{status}</option>)}</select></Field>
              <Field label="Notes"><textarea className="field" rows="2" value={taskForm.notes} onChange={(event) => setTaskForm((current) => ({ ...current, notes: event.target.value }))} /></Field>
              <button className="primary-button compact-primary" type="submit">{taskForm.id ? 'Update Task' : 'Save Task'}</button>
            </form>
            <table className="history-table hospitality-table">
              <thead><tr><th>Date</th><th>Area</th><th>Task</th><th>Status</th><th>Edit</th></tr></thead>
              <tbody>{tasks.length === 0 ? <tr><td colSpan="5">No tasks.</td></tr> : tasks.map((row) => <tr key={row.id}><td>{row.task_date}</td><td>{row.area}</td><td>{row.title}<span className="muted">{row.assigned_to}</span></td><td>{row.status}</td><td><button className="secondary-button" type="button" onClick={() => setTaskForm(row)}>Edit</button></td></tr>)}</tbody>
            </table>
          </div>
        </div>

        <div className="panel">
          <div className="panel-header green"><h2 className="panel-title">Store Inward / Outward</h2></div>
          <div className="panel-body hospitality-section-body">
            <form className="hospitality-form-grid compact" onSubmit={handleStockSave}>
              <Field label="Date"><input className="field" type="date" value={stockForm.movement_date} onChange={(event) => setStockForm((current) => ({ ...current, movement_date: event.target.value }))} /></Field>
              <Field label="Direction"><select className="select" value={stockForm.direction} onChange={(event) => setStockForm((current) => ({ ...current, direction: event.target.value }))}><option value="INWARD">INWARD</option><option value="OUTWARD">OUTWARD</option></select></Field>
              <Field label="Item"><input className="field" value={stockForm.item_name} onChange={(event) => setStockForm((current) => ({ ...current, item_name: event.target.value }))} required /></Field>
              <Field label="Supplier"><input className="field" value={stockForm.supplier_name} onChange={(event) => setStockForm((current) => ({ ...current, supplier_name: event.target.value }))} /></Field>
              <Field label="Qty"><input className="field" type="number" value={stockForm.quantity} onChange={(event) => setStockForm((current) => ({ ...current, quantity: event.target.value }))} /></Field>
              <Field label="Unit"><input className="field" value={stockForm.unit_label} onChange={(event) => setStockForm((current) => ({ ...current, unit_label: event.target.value }))} /></Field>
              <Field label="Amount"><input className="field" type="number" value={stockForm.amount} onChange={(event) => setStockForm((current) => ({ ...current, amount: event.target.value }))} /></Field>
              <Field label="Purpose"><input className="field" value={stockForm.purpose} onChange={(event) => setStockForm((current) => ({ ...current, purpose: event.target.value }))} /></Field>
              <button className="primary-button compact-primary" type="submit">{stockForm.id ? 'Update Movement' : 'Save Movement'}</button>
              <button className="secondary-button" type="button" onClick={() => setStockForm(stockBlank)}>Clear</button>
            </form>
            <table className="history-table hospitality-table">
              <thead><tr><th>Date</th><th>Type</th><th>Item</th><th>Qty</th><th>Amount</th><th>Edit</th></tr></thead>
              <tbody>{stockRows.length === 0 ? <tr><td colSpan="6">No store movements.</td></tr> : stockRows.map((row) => <tr key={row.id}><td>{row.movement_date}</td><td>{row.direction}</td><td>{row.item_name}<span className="muted">{row.supplier_name}</span></td><td>{Number(row.quantity || 0)} {row.unit_label}</td><td>{formatMoney(row.amount)}</td><td><button className="secondary-button" type="button" onClick={() => setStockForm(row)}>Edit</button></td></tr>)}</tbody>
            </table>
          </div>
        </div>
      </section>
    </div>
  );
}
