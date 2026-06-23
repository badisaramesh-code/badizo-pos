import React, { useEffect, useMemo, useState } from 'react';
import {
  fetchStaffAttendance,
  fetchStaffMonthlySheet,
  fetchStaffWorkers,
  saveStaffAttendance,
  saveStaffSalarySheet,
  saveStaffWorker
} from '../api/client';
import { normalizeDateInput, todayIso } from '../utils/date';

const emptyStaff = {
  id: null,
  staff_code: '',
  staff_name: '',
  job_title: '',
  department: '',
  phone: '',
  alternate_phone: '',
  address: '',
  id_proof_type: '',
  id_proof_no: '',
  joining_date: todayIso(),
  salary_type: 'MONTHLY',
  monthly_salary: '',
  daily_wage: '',
  hourly_wage: '',
  bank_account_name: '',
  bank_name: '',
  bank_account_no: '',
  bank_ifsc: '',
  upi_id: '',
  emergency_contact_name: '',
  emergency_contact_phone: '',
  notes: '',
  is_active: true
};

const emptyAttendance = {
  staff_id: '',
  attendance_date: todayIso(),
  status: 'PRESENT',
  in_time: '',
  out_time: '',
  overtime_hours: '',
  daily_wage_override: '',
  remarks: ''
};

const emptySalaryEdit = {
  staff_id: '',
  salary_month: todayIso().slice(0, 7),
  bonus_amount: '',
  advance_amount: '',
  deduction_amount: '',
  payment_status: 'PENDING',
  payment_date: todayIso(),
  payment_mode: 'Cash',
  reference_no: '',
  remarks: ''
};

function money(value) {
  return `Rs. ${Number(value || 0).toFixed(2)}`;
}

export default function StaffPayrollView() {
  const [activeTab, setActiveTab] = useState('staff');
  const [staff, setStaff] = useState([]);
  const [staffSearch, setStaffSearch] = useState('');
  const [staffForm, setStaffForm] = useState(emptyStaff);
  const [attendanceForm, setAttendanceForm] = useState(emptyAttendance);
  const [attendanceFilters, setAttendanceFilters] = useState({ from: todayIso(), to: todayIso(), staffId: '', search: '' });
  const [attendanceRows, setAttendanceRows] = useState([]);
  const [salaryMonth, setSalaryMonth] = useState(todayIso().slice(0, 7));
  const [salarySearch, setSalarySearch] = useState('');
  const [salarySheet, setSalarySheet] = useState({ rows: [], totals: {} });
  const [salaryEdit, setSalaryEdit] = useState(emptySalaryEdit);
  const [statusMessage, setStatusMessage] = useState('');
  const [errorMessage, setErrorMessage] = useState('');

  const selectedSalaryRow = useMemo(() => (
    salarySheet.rows?.find((row) => Number(row.staff?.id) === Number(salaryEdit.staff_id)) || null
  ), [salaryEdit.staff_id, salarySheet.rows]);

  useEffect(() => {
    loadStaff();
    loadAttendance();
    loadSalarySheet();
  }, []);

  async function loadStaff(event) {
    event?.preventDefault?.();
    try {
      setStaff(await fetchStaffWorkers({ search: staffSearch, activeOnly: false }));
    } catch (err) {
      setErrorMessage(err.response?.data?.error || 'Unable to load staff.');
    }
  }

  async function loadAttendance(event) {
    event?.preventDefault?.();
    try {
      setAttendanceRows(await fetchStaffAttendance({
        from: normalizeDateInput(attendanceFilters.from),
        to: normalizeDateInput(attendanceFilters.to),
        staffId: attendanceFilters.staffId,
        search: attendanceFilters.search
      }));
    } catch (err) {
      setErrorMessage(err.response?.data?.error || 'Unable to load attendance.');
    }
  }

  async function loadSalarySheet(event) {
    event?.preventDefault?.();
    try {
      setSalarySheet(await fetchStaffMonthlySheet({ month: salaryMonth, search: salarySearch }));
    } catch (err) {
      setErrorMessage(err.response?.data?.error || 'Unable to load monthly salary sheet.');
    }
  }

  async function handleStaffSave(event) {
    event.preventDefault();
    setStatusMessage('');
    setErrorMessage('');
    try {
      await saveStaffWorker(staffForm);
      setStatusMessage(`${staffForm.staff_name} saved.`);
      setStaffForm(emptyStaff);
      await loadStaff();
    } catch (err) {
      setErrorMessage(err.response?.data?.error || 'Unable to save staff.');
    }
  }

  async function handleAttendanceSave(event) {
    event.preventDefault();
    setStatusMessage('');
    setErrorMessage('');
    try {
      await saveStaffAttendance(attendanceForm);
      setStatusMessage('Muster attendance saved.');
      setAttendanceForm({ ...emptyAttendance, attendance_date: attendanceForm.attendance_date });
      await loadAttendance();
      await loadSalarySheet();
    } catch (err) {
      setErrorMessage(err.response?.data?.error || 'Unable to save attendance.');
    }
  }

  async function handleSalarySave(event) {
    event.preventDefault();
    setStatusMessage('');
    setErrorMessage('');
    try {
      await saveStaffSalarySheet({ ...salaryEdit, salary_month: salaryMonth });
      setStatusMessage('Monthly salary sheet saved.');
      setSalaryEdit({ ...emptySalaryEdit, salary_month: salaryMonth });
      await loadSalarySheet();
    } catch (err) {
      setErrorMessage(err.response?.data?.error || 'Unable to save salary sheet.');
    }
  }

  function editStaff(row) {
    setStaffForm({ ...emptyStaff, ...row, joining_date: normalizeDateInput(row.joining_date || todayIso()) });
    setActiveTab('staff');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function editSalary(row) {
    setSalaryEdit({
      ...emptySalaryEdit,
      staff_id: row.staff.id,
      salary_month: salaryMonth,
      bonus_amount: row.bonus_amount || '',
      advance_amount: row.advance_amount || '',
      deduction_amount: row.deduction_amount || '',
      payment_status: row.payment_status || 'PENDING',
      payment_date: row.payment_date ? normalizeDateInput(row.payment_date) : todayIso(),
      payment_mode: row.payment_mode || 'Cash',
      reference_no: row.reference_no || '',
      remarks: row.remarks || ''
    });
  }

  return (
    <div className="form-stack staff-payroll-view">
      {errorMessage && <div className="alert-box">{errorMessage}</div>}
      {statusMessage && <div className="change-box">{statusMessage}</div>}

      <section className="panel">
        <div className="panel-header green">
          <div>
            <h2 className="panel-title">Staff Attendance & Salaries</h2>
            <span className="panel-subtitle">Workers master, muster posting, monthly salary sheet and accounting posting</span>
          </div>
          <div className="gate-pass-mode-row">
            {['staff', 'attendance', 'salary'].map((tab) => (
              <button key={tab} className={`mode-pill ${activeTab === tab ? 'active' : ''}`} type="button" onClick={() => setActiveTab(tab)}>
                {tab === 'staff' ? 'Staff Master' : tab === 'attendance' ? 'Muster Attendance' : 'Monthly Salary'}
              </button>
            ))}
          </div>
        </div>
      </section>

      {activeTab === 'staff' && (
        <section className="panel">
          <div className="panel-header green">
            <h2 className="panel-title">Staff / Worker Details</h2>
            <form className="report-filter-row" onSubmit={loadStaff}>
              <input className="field" value={staffSearch} onChange={(event) => setStaffSearch(event.target.value)} placeholder="Search name, phone, job, department" />
              <button className="secondary-button" type="submit">Search</button>
            </form>
          </div>
          <form className="panel-body form-stack" onSubmit={handleStaffSave}>
            <div className="staff-payroll-grid">
              <label><span className="field-label">Staff Code</span><input className="field" value={staffForm.staff_code} onChange={(event) => setStaffForm((current) => ({ ...current, staff_code: event.target.value.toUpperCase() }))} /></label>
              <label><span className="field-label">Name</span><input className="field" value={staffForm.staff_name} onChange={(event) => setStaffForm((current) => ({ ...current, staff_name: event.target.value }))} required /></label>
              <label><span className="field-label">Job Detail</span><input className="field" value={staffForm.job_title} onChange={(event) => setStaffForm((current) => ({ ...current, job_title: event.target.value }))} placeholder="Cashier, Loader, Cleaner" /></label>
              <label><span className="field-label">Department</span><input className="field" value={staffForm.department} onChange={(event) => setStaffForm((current) => ({ ...current, department: event.target.value }))} /></label>
              <label><span className="field-label">Phone</span><input className="field" value={staffForm.phone} onChange={(event) => setStaffForm((current) => ({ ...current, phone: event.target.value }))} /></label>
              <label><span className="field-label">Alternate Phone</span><input className="field" value={staffForm.alternate_phone} onChange={(event) => setStaffForm((current) => ({ ...current, alternate_phone: event.target.value }))} /></label>
              <label className="staff-payroll-wide"><span className="field-label">Address</span><input className="field" value={staffForm.address} onChange={(event) => setStaffForm((current) => ({ ...current, address: event.target.value }))} /></label>
              <label><span className="field-label">ID Proof Type</span><input className="field" value={staffForm.id_proof_type} onChange={(event) => setStaffForm((current) => ({ ...current, id_proof_type: event.target.value }))} placeholder="Aadhaar, PAN" /></label>
              <label><span className="field-label">ID Proof No</span><input className="field" value={staffForm.id_proof_no} onChange={(event) => setStaffForm((current) => ({ ...current, id_proof_no: event.target.value }))} /></label>
              <label><span className="field-label">Joining Date</span><input className="field" type="date" value={normalizeDateInput(staffForm.joining_date)} onChange={(event) => setStaffForm((current) => ({ ...current, joining_date: event.target.value }))} /></label>
              <label><span className="field-label">Salary Type</span><select className="select" value={staffForm.salary_type} onChange={(event) => setStaffForm((current) => ({ ...current, salary_type: event.target.value }))}><option value="MONTHLY">Monthly</option><option value="DAILY">Daily</option><option value="HOURLY">Hourly</option></select></label>
              <label><span className="field-label">Monthly Salary</span><input className="field" type="number" value={staffForm.monthly_salary} onChange={(event) => setStaffForm((current) => ({ ...current, monthly_salary: event.target.value }))} /></label>
              <label><span className="field-label">Daily Wage</span><input className="field" type="number" value={staffForm.daily_wage} onChange={(event) => setStaffForm((current) => ({ ...current, daily_wage: event.target.value }))} /></label>
              <label><span className="field-label">Hourly Wage</span><input className="field" type="number" value={staffForm.hourly_wage} onChange={(event) => setStaffForm((current) => ({ ...current, hourly_wage: event.target.value }))} /></label>
              <label><span className="field-label">Bank Account Name</span><input className="field" value={staffForm.bank_account_name} onChange={(event) => setStaffForm((current) => ({ ...current, bank_account_name: event.target.value }))} /></label>
              <label><span className="field-label">Bank Name</span><input className="field" value={staffForm.bank_name} onChange={(event) => setStaffForm((current) => ({ ...current, bank_name: event.target.value }))} /></label>
              <label><span className="field-label">Account No</span><input className="field" value={staffForm.bank_account_no} onChange={(event) => setStaffForm((current) => ({ ...current, bank_account_no: event.target.value }))} /></label>
              <label><span className="field-label">IFSC</span><input className="field" value={staffForm.bank_ifsc} onChange={(event) => setStaffForm((current) => ({ ...current, bank_ifsc: event.target.value.toUpperCase() }))} /></label>
              <label><span className="field-label">UPI ID</span><input className="field" value={staffForm.upi_id} onChange={(event) => setStaffForm((current) => ({ ...current, upi_id: event.target.value }))} /></label>
              <label><span className="field-label">Emergency Name</span><input className="field" value={staffForm.emergency_contact_name} onChange={(event) => setStaffForm((current) => ({ ...current, emergency_contact_name: event.target.value }))} /></label>
              <label><span className="field-label">Emergency Phone</span><input className="field" value={staffForm.emergency_contact_phone} onChange={(event) => setStaffForm((current) => ({ ...current, emergency_contact_phone: event.target.value }))} /></label>
              <label className="change-box"><input type="checkbox" checked={staffForm.is_active} onChange={(event) => setStaffForm((current) => ({ ...current, is_active: event.target.checked }))} /> Active</label>
              <label className="staff-payroll-wide"><span className="field-label">Notes</span><input className="field" value={staffForm.notes} onChange={(event) => setStaffForm((current) => ({ ...current, notes: event.target.value }))} /></label>
            </div>
            <div className="report-action-row">
              <button className="secondary-button" type="button" onClick={() => setStaffForm(emptyStaff)}>Clear</button>
              <button className="primary-button compact-primary" type="submit">Save Staff</button>
            </div>
          </form>
          <div className="panel-body table-scroll">
            <table className="history-table staff-payroll-table">
              <thead><tr><th>Name</th><th>Job</th><th>Phone</th><th>Address</th><th>Pay</th><th>Bank/UPI</th><th>Status</th><th>Action</th></tr></thead>
              <tbody>{staff.length === 0 ? <tr><td colSpan="8">No staff added.</td></tr> : staff.map((row) => (
                <tr key={row.id}>
                  <td><strong>{row.staff_name}</strong><br /><span className="muted">{row.staff_code || '-'}</span></td>
                  <td>{row.job_title || '-'}<br /><span className="muted">{row.department || '-'}</span></td>
                  <td>{row.phone || '-'}<br /><span className="muted">{row.alternate_phone || ''}</span></td>
                  <td>{row.address || '-'}</td>
                  <td>{row.salary_type}<br /><span className="muted">{money(row.monthly_salary || row.daily_wage || row.hourly_wage)}</span></td>
                  <td>{row.bank_name || '-'}<br /><span className="muted">{row.upi_id || row.bank_account_no || '-'}</span></td>
                  <td>{row.is_active ? 'Active' : 'Inactive'}</td>
                  <td><button className="secondary-button" type="button" onClick={() => editStaff(row)}>Edit</button></td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        </section>
      )}

      {activeTab === 'attendance' && (
        <section className="panel">
          <div className="panel-header green"><h2 className="panel-title">Muster Posting</h2></div>
          <form className="panel-body form-stack" onSubmit={handleAttendanceSave}>
            <div className="staff-payroll-grid">
              <label><span className="field-label">Staff</span><select className="select" value={attendanceForm.staff_id} onChange={(event) => setAttendanceForm((current) => ({ ...current, staff_id: event.target.value }))} required><option value="">Select staff</option>{staff.filter((row) => row.is_active).map((row) => <option key={row.id} value={row.id}>{row.staff_name} - {row.job_title}</option>)}</select></label>
              <label><span className="field-label">Date</span><input className="field" type="date" value={normalizeDateInput(attendanceForm.attendance_date)} onChange={(event) => setAttendanceForm((current) => ({ ...current, attendance_date: event.target.value }))} /></label>
              <label><span className="field-label">Status</span><select className="select" value={attendanceForm.status} onChange={(event) => setAttendanceForm((current) => ({ ...current, status: event.target.value }))}><option value="PRESENT">Present</option><option value="HALF_DAY">Half Day</option><option value="ABSENT">Absent</option><option value="PAID_LEAVE">Paid Leave</option><option value="WEEK_OFF">Week Off</option></select></label>
              <label><span className="field-label">In Time</span><input className="field" type="time" value={attendanceForm.in_time} onChange={(event) => setAttendanceForm((current) => ({ ...current, in_time: event.target.value }))} /></label>
              <label><span className="field-label">Out Time</span><input className="field" type="time" value={attendanceForm.out_time} onChange={(event) => setAttendanceForm((current) => ({ ...current, out_time: event.target.value }))} /></label>
              <label><span className="field-label">Overtime Hours</span><input className="field" type="number" step="0.25" value={attendanceForm.overtime_hours} onChange={(event) => setAttendanceForm((current) => ({ ...current, overtime_hours: event.target.value }))} /></label>
              <label><span className="field-label">Daily Wage Override</span><input className="field" type="number" value={attendanceForm.daily_wage_override} onChange={(event) => setAttendanceForm((current) => ({ ...current, daily_wage_override: event.target.value }))} /></label>
              <label className="staff-payroll-wide"><span className="field-label">Remarks</span><input className="field" value={attendanceForm.remarks} onChange={(event) => setAttendanceForm((current) => ({ ...current, remarks: event.target.value }))} /></label>
            </div>
            <button className="primary-button compact-primary" type="submit">Save Muster Entry</button>
          </form>
          <div className="panel-body form-stack">
            <form className="report-filter-row" onSubmit={loadAttendance}>
              <input className="field report-date-input" type="date" value={normalizeDateInput(attendanceFilters.from)} onChange={(event) => setAttendanceFilters((current) => ({ ...current, from: event.target.value }))} />
              <input className="field report-date-input" type="date" value={normalizeDateInput(attendanceFilters.to)} onChange={(event) => setAttendanceFilters((current) => ({ ...current, to: event.target.value }))} />
              <select className="select" value={attendanceFilters.staffId} onChange={(event) => setAttendanceFilters((current) => ({ ...current, staffId: event.target.value }))}><option value="">All Staff</option>{staff.map((row) => <option key={row.id} value={row.id}>{row.staff_name}</option>)}</select>
              <input className="field" value={attendanceFilters.search} onChange={(event) => setAttendanceFilters((current) => ({ ...current, search: event.target.value }))} placeholder="Search staff/job/phone" />
              <button className="secondary-button" type="submit">View</button>
            </form>
            <div className="table-scroll">
              <table className="history-table">
                <thead><tr><th>Date</th><th>Name</th><th>Job</th><th>Status</th><th>In</th><th>Out</th><th>OT</th><th>Wage Override</th><th>Remarks</th></tr></thead>
                <tbody>{attendanceRows.length === 0 ? <tr><td colSpan="9">No muster entries.</td></tr> : attendanceRows.map((row) => (
                  <tr key={row.id}><td>{row.attendance_date}</td><td>{row.staff_name}</td><td>{row.job_title}<br /><span className="muted">{row.department}</span></td><td>{row.status}</td><td>{row.in_time || '-'}</td><td>{row.out_time || '-'}</td><td>{row.overtime_hours || 0}</td><td>{row.daily_wage_override ? money(row.daily_wage_override) : '-'}</td><td>{row.remarks || '-'}</td></tr>
                ))}</tbody>
              </table>
            </div>
          </div>
        </section>
      )}

      {activeTab === 'salary' && (
        <section className="panel">
          <div className="panel-header green">
            <h2 className="panel-title">Monthly Salary Sheet</h2>
            <form className="report-filter-row" onSubmit={loadSalarySheet}>
              <input className="field report-date-input" type="month" value={salaryMonth} onChange={(event) => setSalaryMonth(event.target.value)} />
              <input className="field" value={salarySearch} onChange={(event) => setSalarySearch(event.target.value)} placeholder="Search staff/job/phone" />
              <button className="secondary-button" type="submit">View Month</button>
            </form>
          </div>
          <div className="panel-body form-stack">
            <div className="closing-metrics">
              <div className="metric-card"><span>Total Staff</span><strong>{salarySheet.totals?.staff_count || 0}</strong></div>
              <div className="metric-card"><span>Net Salary</span><strong>{money(salarySheet.totals?.net_salary)}</strong></div>
              <div className="metric-card"><span>Paid</span><strong>{money(salarySheet.totals?.paid_salary)}</strong></div>
              <div className="metric-card"><span>Pending</span><strong>{money(salarySheet.totals?.pending_salary)}</strong></div>
            </div>
            <form className="staff-payroll-grid" onSubmit={handleSalarySave}>
              <label><span className="field-label">Staff</span><select className="select" value={salaryEdit.staff_id} onChange={(event) => setSalaryEdit((current) => ({ ...current, staff_id: event.target.value }))} required><option value="">Select salary row</option>{salarySheet.rows?.map((row) => <option key={row.staff.id} value={row.staff.id}>{row.staff.staff_name}</option>)}</select></label>
              <label><span className="field-label">Bonus</span><input className="field" type="number" value={salaryEdit.bonus_amount} onChange={(event) => setSalaryEdit((current) => ({ ...current, bonus_amount: event.target.value }))} /></label>
              <label><span className="field-label">Advance</span><input className="field" type="number" value={salaryEdit.advance_amount} onChange={(event) => setSalaryEdit((current) => ({ ...current, advance_amount: event.target.value }))} /></label>
              <label><span className="field-label">Deduction</span><input className="field" type="number" value={salaryEdit.deduction_amount} onChange={(event) => setSalaryEdit((current) => ({ ...current, deduction_amount: event.target.value }))} /></label>
              <label><span className="field-label">Payment Status</span><select className="select" value={salaryEdit.payment_status} onChange={(event) => setSalaryEdit((current) => ({ ...current, payment_status: event.target.value }))}><option value="PENDING">Pending</option><option value="PAID">Paid & Post Ledger</option></select></label>
              <label><span className="field-label">Payment Date</span><input className="field" type="date" value={normalizeDateInput(salaryEdit.payment_date)} onChange={(event) => setSalaryEdit((current) => ({ ...current, payment_date: event.target.value }))} /></label>
              <label><span className="field-label">Payment Mode</span><select className="select" value={salaryEdit.payment_mode} onChange={(event) => setSalaryEdit((current) => ({ ...current, payment_mode: event.target.value }))}><option>Cash</option><option>UPI</option><option>Bank</option><option>Other</option></select></label>
              <label><span className="field-label">Reference No</span><input className="field" value={salaryEdit.reference_no} onChange={(event) => setSalaryEdit((current) => ({ ...current, reference_no: event.target.value }))} /></label>
              <label className="staff-payroll-wide"><span className="field-label">Remarks</span><input className="field" value={salaryEdit.remarks} onChange={(event) => setSalaryEdit((current) => ({ ...current, remarks: event.target.value }))} /></label>
              <div className="change-box">Calculated Net: <strong>{selectedSalaryRow ? money(selectedSalaryRow.net_salary) : '-'}</strong></div>
              <button className="primary-button compact-primary" type="submit">Save Salary Sheet</button>
            </form>
            <div className="table-scroll">
              <table className="history-table staff-payroll-table">
                <thead><tr><th>Staff</th><th>Job</th><th>Present</th><th>Leave/Absent</th><th>Base</th><th>OT</th><th>Bonus</th><th>Advance</th><th>Deduction</th><th>Net</th><th>Status</th><th>Action</th></tr></thead>
                <tbody>{!salarySheet.rows?.length ? <tr><td colSpan="12">No staff for selected month.</td></tr> : salarySheet.rows.map((row) => (
                  <tr key={row.staff.id}>
                    <td>{row.staff.staff_name}<br /><span className="muted">{row.staff.phone}</span></td>
                    <td>{row.staff.job_title}<br /><span className="muted">{row.staff.department}</span></td>
                    <td>{row.present_days}</td>
                    <td>{row.paid_leave_days} / {row.absent_days}</td>
                    <td>{money(row.base_salary)}</td>
                    <td>{row.overtime_hours}h<br /><span className="muted">{money(row.overtime_amount)}</span></td>
                    <td>{money(row.bonus_amount)}</td>
                    <td>{money(row.advance_amount)}</td>
                    <td>{money(row.deduction_amount)}</td>
                    <td><strong>{money(row.net_salary)}</strong></td>
                    <td>{row.payment_status}{row.posted_to_cash_ledger ? ' / Posted' : ''}</td>
                    <td><button className="secondary-button" type="button" onClick={() => editSalary(row)}>Edit/Post</button></td>
                  </tr>
                ))}</tbody>
              </table>
            </div>
          </div>
        </section>
      )}
    </div>
  );
}
