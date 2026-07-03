import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  fetchSettings,
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
  sunday_days: '',
  holiday_days: '',
  days_worked: '',
  unmarked_absent_days: '',
  per_day_amount: '',
  pf_base_amount: '',
  financial_year: '',
  branch_name: 'Main Branch',
  da_amount: '',
  hra_amount: '',
  conveyance_amount: '',
  medical_amount: '',
  special_amount: '',
  other_earning_amount: '',
  bonus_amount: '',
  advance_amount: '',
  pf_amount: '',
  esi_amount: '',
  professional_tax_amount: '',
  tds_amount: '',
  other_deduction_amount: '',
  canteen_deduction_amount: '',
  canteen_item: '',
  canteen_tokens: '',
  canteen_rate: '',
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

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function monthLabel(month) {
  const [year, monthNo] = String(month || '').split('-').map(Number);
  if (!year || !monthNo) return String(month || '');
  return new Date(year, monthNo - 1, 1).toLocaleString('en-IN', { month: 'long', year: 'numeric' });
}

function monthsBetweenDates(fromDate, toDate) {
  const from = normalizeDateInput(fromDate || todayIso());
  const to = normalizeDateInput(toDate || from);
  const start = new Date(`${from <= to ? from : to}T00:00:00`);
  const end = new Date(`${from <= to ? to : from}T00:00:00`);
  const months = [];
  let year = start.getFullYear();
  let month = start.getMonth();
  const endKey = (end.getFullYear() * 12) + end.getMonth();

  while ((year * 12) + month <= endKey && months.length < 36) {
    months.push(`${year}-${String(month + 1).padStart(2, '0')}`);
    month += 1;
    if (month > 11) {
      month = 0;
      year += 1;
    }
  }

  return months;
}

function staffMatchesSearch(staffMember, search) {
  const needle = String(search || '').trim().toLowerCase();
  if (!needle) return true;
  return [
    staffMember?.staff_name,
    staffMember?.staff_code,
    staffMember?.phone,
    staffMember?.job_title,
    staffMember?.department
  ].some((value) => String(value || '').toLowerCase().includes(needle));
}

function numberToWordsIndian(value) {
  const amount = Math.round(Number(value || 0));
  if (amount === 0) return 'Zero Only';
  const ones = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
  const tens = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];
  const belowHundred = (num) => (num < 20 ? ones[num] : `${tens[Math.floor(num / 10)]}${num % 10 ? ` ${ones[num % 10]}` : ''}`);
  const belowThousand = (num) => `${num >= 100 ? `${ones[Math.floor(num / 100)]} Hundred${num % 100 ? ' ' : ''}` : ''}${num % 100 ? belowHundred(num % 100) : ''}`;
  const parts = [];
  let remaining = amount;
  [['Crore', 10000000], ['Lakh', 100000], ['Thousand', 1000]].forEach(([label, divisor]) => {
    const chunk = Math.floor(remaining / divisor);
    if (chunk) {
      parts.push(`${belowThousand(chunk)} ${label}`);
      remaining %= divisor;
    }
  });
  if (remaining) parts.push(belowThousand(remaining));
  return `${parts.join(' ')} Only`;
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
  const [payslipFilters, setPayslipFilters] = useState({ search: '', from: `${todayIso().slice(0, 7)}-01`, to: todayIso() });
  const [payslipRows, setPayslipRows] = useState([]);
  const [isPayslipLoading, setIsPayslipLoading] = useState(false);
  const [payslipPreviewHtml, setPayslipPreviewHtml] = useState('');
  const [payslipPreviewTitle, setPayslipPreviewTitle] = useState('');
  const [shopSettings, setShopSettings] = useState({});
  const [statusMessage, setStatusMessage] = useState('');
  const [errorMessage, setErrorMessage] = useState('');
  const payslipFrameRef = useRef(null);

  const selectedSalaryRow = useMemo(() => (
    salarySheet.rows?.find((row) => Number(row.staff?.id) === Number(salaryEdit.staff_id)) || null
  ), [salaryEdit.staff_id, salarySheet.rows]);

  useEffect(() => {
    loadStaff();
    loadAttendance();
    loadSalarySheet();
    loadSettings();
  }, []);

  async function loadSettings() {
    try {
      setShopSettings(await fetchSettings());
    } catch (err) {
      setShopSettings({});
    }
  }

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

  async function loadPayslips(event) {
    event?.preventDefault?.();
    setStatusMessage('');
    setErrorMessage('');
    setIsPayslipLoading(true);
    try {
      const months = monthsBetweenDates(payslipFilters.from, payslipFilters.to);
      const sheets = await Promise.all(months.map((month) => fetchStaffMonthlySheet({ month, search: '' })));
      const rows = sheets.flatMap((sheet) => (sheet.rows || [])
        .filter((row) => staffMatchesSearch(row.staff, payslipFilters.search))
        .map((row) => ({ ...row, salary_month: sheet.month || row.salary_month })));
      setPayslipRows(rows);
      setStatusMessage(`${rows.length} payslip rows loaded.`);
    } catch (err) {
      setErrorMessage(err.response?.data?.error || 'Unable to load payslips.');
    } finally {
      setIsPayslipLoading(false);
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
      sunday_days: row.sunday_days || '',
      holiday_days: row.holiday_days || '',
      days_worked: row.days_worked || '',
      unmarked_absent_days: row.unmarked_absent_days || '',
      per_day_amount: row.per_day_amount || '',
      pf_base_amount: row.pf_base_amount || '',
      financial_year: row.financial_year || '',
      branch_name: row.branch_name || 'Main Branch',
      da_amount: row.da_amount || '',
      hra_amount: row.hra_amount || '',
      conveyance_amount: row.conveyance_amount || '',
      medical_amount: row.medical_amount || '',
      special_amount: row.special_amount || '',
      other_earning_amount: row.other_earning_amount || '',
      bonus_amount: row.bonus_amount || '',
      advance_amount: row.advance_amount || '',
      pf_amount: row.pf_amount || '',
      esi_amount: row.esi_amount || '',
      professional_tax_amount: row.professional_tax_amount || '',
      tds_amount: row.tds_amount || '',
      other_deduction_amount: row.other_deduction_amount || '',
      canteen_deduction_amount: row.canteen_deduction_amount || '',
      canteen_item: row.canteen_item || '',
      canteen_tokens: row.canteen_tokens || '',
      canteen_rate: row.canteen_rate || '',
      deduction_amount: row.deduction_amount || '',
      payment_status: row.payment_status || 'PENDING',
      payment_date: row.payment_date ? normalizeDateInput(row.payment_date) : todayIso(),
      payment_mode: row.payment_mode || 'Cash',
      reference_no: row.reference_no || '',
      remarks: row.remarks || ''
    });
  }

  function printPayslip(row, autoPrint = true) {
    const staffMember = row.staff || {};
    const storeName = shopSettings.shop_name || 'Hyper Fresh Mart LLP';
    const storeAddress = shopSettings.address || 'Sathupally - Khammam(dt) - 507303';
    const storePhone = shopSettings.phone || '';
    const storeGst = shopSettings.gst_number || '';
    const generatedAt = new Date().toISOString().slice(0, 10);
    const earnings = [
      ['Earned Basic', row.base_salary],
      ['Earned DA', row.da_amount],
      ['Earned HRA', row.hra_amount],
      ['Earned Conveyance', row.conveyance_amount],
      ['Earned Medical', row.medical_amount],
      ['Earned Special', row.special_amount],
      ['Earned Other', row.other_earning_amount],
      ['Overtime', row.overtime_amount],
      ['Bonus', row.bonus_amount]
    ];
    const deductions = [
      ['PF', row.pf_amount],
      ['ESI', row.esi_amount],
      ['Professional Tax', row.professional_tax_amount],
      ['TDS', row.tds_amount],
      ['Advance', row.advance_amount],
      ['Other Deduction', row.other_deduction_amount],
      ['Canteen Deduction', row.canteen_deduction_amount],
      ['Deduction', row.deduction_amount]
    ];
    const totalEarnings = earnings.reduce((sum, item) => sum + Number(item[1] || 0), 0);
    const totalDeductions = deductions.reduce((sum, item) => sum + Number(item[1] || 0), 0);
    const rowsHtml = (rows) => rows.map(([label, amount]) => `
      <tr><td>${escapeHtml(label)}</td><td class="amount">${money(amount)}</td></tr>
    `).join('');

    const payslipHtml = `<!doctype html>
<html>
<head>
  <title>Payslip - ${escapeHtml(staffMember.staff_name || '')}</title>
  <style>
    @page { size: A4; margin: 12mm; }
    * { box-sizing: border-box; }
    body { margin: 0; color: #17202a; font-family: Arial, sans-serif; font-size: 12px; }
    .payslip { border: 1px solid #1f2937; min-height: 270mm; padding: 14px; }
    .store { text-align: center; border-bottom: 2px solid #1f2937; padding-bottom: 10px; }
    .store h1 { margin: 0 0 5px; font-size: 24px; letter-spacing: .5px; text-transform: uppercase; }
    .store p { margin: 2px 0; font-weight: 700; }
    .title { margin: 12px 0; padding: 8px; background: #dff5df; border: 1px solid #9ccaa6; font-size: 18px; font-weight: 900; text-align: center; }
    .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
    table { width: 100%; border-collapse: collapse; }
    th, td { border: 1px solid #9aa6a0; padding: 6px 8px; vertical-align: top; }
    th { background: #eef8f2; text-align: left; font-size: 12px; text-transform: uppercase; }
    .label { color: #4b5563; font-weight: 800; }
    .amount { text-align: right; font-weight: 900; }
    .section { margin-top: 10px; }
    .net { margin-top: 12px; display: grid; grid-template-columns: 1fr auto; gap: 10px; align-items: center; border: 2px solid #155f22; padding: 10px; }
    .net strong { font-size: 22px; }
    .words { margin-top: 8px; font-weight: 800; }
    .note { margin-top: 12px; color: #4b5563; font-size: 11px; }
    .sign { display: grid; grid-template-columns: 1fr 1fr; gap: 60px; margin-top: 54px; font-weight: 800; text-align: center; }
    .sign div { border-top: 1px solid #1f2937; padding-top: 8px; }
    @media print { body { -webkit-print-color-adjust: exact; print-color-adjust: exact; } }
  </style>
</head>
<body>
  <div class="payslip">
    <div class="store">
      <h1>${escapeHtml(storeName)}</h1>
      <p>${escapeHtml(storeAddress)}</p>
      <p>${storePhone ? `Ph: ${escapeHtml(storePhone)}` : ''}${storeGst ? ` | GST: ${escapeHtml(storeGst)}` : ''}</p>
    </div>
    <div class="title">Employee Payslip - ${escapeHtml(monthLabel(row.salary_month || salaryMonth))}</div>
    <table>
      <thead><tr><th colspan="4">Employee Details</th></tr></thead>
      <tbody>
        <tr><td class="label">Emp Code</td><td>${escapeHtml(staffMember.staff_code || '-')}</td><td class="label">Employee</td><td>${escapeHtml(staffMember.staff_name || '-')}</td></tr>
        <tr><td class="label">Department</td><td>${escapeHtml(staffMember.department || '-')}</td><td class="label">Designation</td><td>${escapeHtml(staffMember.job_title || '-')}</td></tr>
        <tr><td class="label">Branch</td><td>${escapeHtml(row.branch_name || 'Main Branch')}</td><td class="label">Period</td><td>${escapeHtml(monthLabel(row.salary_month || salaryMonth))}</td></tr>
        <tr><td class="label">Month Days</td><td>${Number(row.working_days || 0).toFixed(2)}</td><td class="label">Sundays</td><td>${Number(row.sunday_days || 0).toFixed(2)}</td></tr>
        <tr><td class="label">Holidays</td><td>${Number(row.holiday_days || 0).toFixed(2)}</td><td class="label">Working</td><td>${Math.max(Number(row.working_days || 0) - Number(row.sunday_days || 0) - Number(row.holiday_days || 0), 0).toFixed(2)}</td></tr>
        <tr><td class="label">Days Worked</td><td>${Number(row.days_worked || row.present_days || 0).toFixed(2)}</td><td class="label">Present</td><td>${Number(row.present_days || 0).toFixed(2)}</td></tr>
        <tr><td class="label">Paid Leaves</td><td>${Number(row.paid_leave_days || 0).toFixed(2)}</td><td class="label">Absent/LOP</td><td>${Number(row.absent_days || 0).toFixed(2)}</td></tr>
        <tr><td class="label">Half Days</td><td>${Number(row.half_days || 0).toFixed(2)}</td><td class="label">Unmarked Absent</td><td>${Number(row.unmarked_absent_days || 0).toFixed(2)}</td></tr>
        <tr><td class="label">Per Day</td><td>${money(row.per_day_amount)}</td><td class="label">PF Base</td><td>${money(row.pf_base_amount)}</td></tr>
        <tr><td class="label">FY</td><td>${escapeHtml(row.financial_year || '')}</td><td class="label">Generated</td><td>${escapeHtml(generatedAt)}</td></tr>
      </tbody>
    </table>
    <div class="grid section">
      <table>
        <thead><tr><th colspan="2">Earnings</th></tr></thead>
        <tbody>${rowsHtml(earnings)}<tr><th>Total Earnings</th><th class="amount">${money(totalEarnings)}</th></tr></tbody>
      </table>
      <table>
        <thead><tr><th colspan="2">Deductions</th></tr></thead>
        <tbody>${rowsHtml(deductions)}<tr><th>Total Deductions</th><th class="amount">${money(totalDeductions)}</th></tr></tbody>
      </table>
    </div>
    ${Number(row.canteen_deduction_amount || 0) > 0 || row.canteen_item ? `
    <div class="section">
      <table>
        <thead><tr><th colspan="4">Canteen Deduction Breakup</th></tr><tr><th>Item</th><th class="amount">Tokens</th><th class="amount">Rate</th><th class="amount">Amount</th></tr></thead>
        <tbody><tr><td>${escapeHtml(row.canteen_item || 'Canteen')}</td><td class="amount">${Number(row.canteen_tokens || 0).toFixed(2)}</td><td class="amount">${money(row.canteen_rate)}</td><td class="amount">${money(row.canteen_deduction_amount)}</td></tr></tbody>
      </table>
    </div>` : ''}
    <div class="net"><span>Net Pay</span><strong>${money(row.net_salary)}</strong></div>
    <div class="words">Amount in Words: ${escapeHtml(numberToWordsIndian(row.net_salary))}</div>
    <div class="note">This is a system generated payslip from Badizo POS payroll. Salary values are based on staff master, muster attendance and monthly salary sheet.</div>
    <div class="sign"><div>Employee Signature</div><div>Authorized Signatory</div></div>
  </div>
</body>
</html>`;
    setPayslipPreviewTitle(`Payslip - ${staffMember.staff_name || ''} - ${monthLabel(row.salary_month || salaryMonth)}`);
    setPayslipPreviewHtml(payslipHtml);
    if (autoPrint) {
      window.setTimeout(() => {
        const frameWindow = payslipFrameRef.current?.contentWindow;
        frameWindow?.focus?.();
        frameWindow?.print?.();
      }, 250);
    }
  }

  function viewPayslip(row) {
    printPayslip(row, false);
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
              <label><span className="field-label">Branch</span><input className="field" value={salaryEdit.branch_name} onChange={(event) => setSalaryEdit((current) => ({ ...current, branch_name: event.target.value }))} /></label>
              <label><span className="field-label">Financial Year</span><input className="field" value={salaryEdit.financial_year} onChange={(event) => setSalaryEdit((current) => ({ ...current, financial_year: event.target.value }))} placeholder="2026-2027" /></label>
              <label><span className="field-label">Sundays</span><input className="field" type="number" step="0.5" value={salaryEdit.sunday_days} onChange={(event) => setSalaryEdit((current) => ({ ...current, sunday_days: event.target.value }))} /></label>
              <label><span className="field-label">Holidays</span><input className="field" type="number" step="0.5" value={salaryEdit.holiday_days} onChange={(event) => setSalaryEdit((current) => ({ ...current, holiday_days: event.target.value }))} /></label>
              <label><span className="field-label">Days Worked</span><input className="field" type="number" step="0.5" value={salaryEdit.days_worked} onChange={(event) => setSalaryEdit((current) => ({ ...current, days_worked: event.target.value }))} /></label>
              <label><span className="field-label">Unmarked Absent</span><input className="field" type="number" step="0.5" value={salaryEdit.unmarked_absent_days} onChange={(event) => setSalaryEdit((current) => ({ ...current, unmarked_absent_days: event.target.value }))} /></label>
              <label><span className="field-label">Per Day</span><input className="field" type="number" value={salaryEdit.per_day_amount} onChange={(event) => setSalaryEdit((current) => ({ ...current, per_day_amount: event.target.value }))} /></label>
              <label><span className="field-label">PF Base</span><input className="field" type="number" value={salaryEdit.pf_base_amount} onChange={(event) => setSalaryEdit((current) => ({ ...current, pf_base_amount: event.target.value }))} /></label>
              <label><span className="field-label">DA</span><input className="field" type="number" value={salaryEdit.da_amount} onChange={(event) => setSalaryEdit((current) => ({ ...current, da_amount: event.target.value }))} /></label>
              <label><span className="field-label">HRA</span><input className="field" type="number" value={salaryEdit.hra_amount} onChange={(event) => setSalaryEdit((current) => ({ ...current, hra_amount: event.target.value }))} /></label>
              <label><span className="field-label">Conveyance</span><input className="field" type="number" value={salaryEdit.conveyance_amount} onChange={(event) => setSalaryEdit((current) => ({ ...current, conveyance_amount: event.target.value }))} /></label>
              <label><span className="field-label">Medical</span><input className="field" type="number" value={salaryEdit.medical_amount} onChange={(event) => setSalaryEdit((current) => ({ ...current, medical_amount: event.target.value }))} /></label>
              <label><span className="field-label">Special</span><input className="field" type="number" value={salaryEdit.special_amount} onChange={(event) => setSalaryEdit((current) => ({ ...current, special_amount: event.target.value }))} /></label>
              <label><span className="field-label">Other Earning</span><input className="field" type="number" value={salaryEdit.other_earning_amount} onChange={(event) => setSalaryEdit((current) => ({ ...current, other_earning_amount: event.target.value }))} /></label>
              <label><span className="field-label">Bonus</span><input className="field" type="number" value={salaryEdit.bonus_amount} onChange={(event) => setSalaryEdit((current) => ({ ...current, bonus_amount: event.target.value }))} /></label>
              <label><span className="field-label">Advance</span><input className="field" type="number" value={salaryEdit.advance_amount} onChange={(event) => setSalaryEdit((current) => ({ ...current, advance_amount: event.target.value }))} /></label>
              <label><span className="field-label">PF</span><input className="field" type="number" value={salaryEdit.pf_amount} onChange={(event) => setSalaryEdit((current) => ({ ...current, pf_amount: event.target.value }))} /></label>
              <label><span className="field-label">ESI</span><input className="field" type="number" value={salaryEdit.esi_amount} onChange={(event) => setSalaryEdit((current) => ({ ...current, esi_amount: event.target.value }))} /></label>
              <label><span className="field-label">Professional Tax</span><input className="field" type="number" value={salaryEdit.professional_tax_amount} onChange={(event) => setSalaryEdit((current) => ({ ...current, professional_tax_amount: event.target.value }))} /></label>
              <label><span className="field-label">TDS</span><input className="field" type="number" value={salaryEdit.tds_amount} onChange={(event) => setSalaryEdit((current) => ({ ...current, tds_amount: event.target.value }))} /></label>
              <label><span className="field-label">Other Deduction</span><input className="field" type="number" value={salaryEdit.other_deduction_amount} onChange={(event) => setSalaryEdit((current) => ({ ...current, other_deduction_amount: event.target.value }))} /></label>
              <label><span className="field-label">Canteen Item</span><input className="field" value={salaryEdit.canteen_item} onChange={(event) => setSalaryEdit((current) => ({ ...current, canteen_item: event.target.value }))} placeholder="Meals" /></label>
              <label><span className="field-label">Canteen Tokens</span><input className="field" type="number" step="0.5" value={salaryEdit.canteen_tokens} onChange={(event) => setSalaryEdit((current) => ({ ...current, canteen_tokens: event.target.value }))} /></label>
              <label><span className="field-label">Canteen Rate</span><input className="field" type="number" value={salaryEdit.canteen_rate} onChange={(event) => setSalaryEdit((current) => ({ ...current, canteen_rate: event.target.value }))} /></label>
              <label><span className="field-label">Canteen Deduction</span><input className="field" type="number" value={salaryEdit.canteen_deduction_amount} onChange={(event) => setSalaryEdit((current) => ({ ...current, canteen_deduction_amount: event.target.value }))} /></label>
              <label><span className="field-label">Deduction</span><input className="field" type="number" value={salaryEdit.deduction_amount} onChange={(event) => setSalaryEdit((current) => ({ ...current, deduction_amount: event.target.value }))} /></label>
              <label><span className="field-label">Payment Status</span><select className="select" value={salaryEdit.payment_status} onChange={(event) => setSalaryEdit((current) => ({ ...current, payment_status: event.target.value }))}><option value="PENDING">Pending</option><option value="PAID">Paid & Post Ledger</option></select></label>
              <label><span className="field-label">Payment Date</span><input className="field" type="date" value={normalizeDateInput(salaryEdit.payment_date)} onChange={(event) => setSalaryEdit((current) => ({ ...current, payment_date: event.target.value }))} /></label>
              <label><span className="field-label">Payment Mode</span><select className="select" value={salaryEdit.payment_mode} onChange={(event) => setSalaryEdit((current) => ({ ...current, payment_mode: event.target.value }))}><option>Cash</option><option>UPI</option><option>Bank</option><option>Other</option></select></label>
              <label><span className="field-label">Reference No</span><input className="field" value={salaryEdit.reference_no} onChange={(event) => setSalaryEdit((current) => ({ ...current, reference_no: event.target.value }))} /></label>
              <label className="staff-payroll-wide"><span className="field-label">Remarks</span><input className="field" value={salaryEdit.remarks} onChange={(event) => setSalaryEdit((current) => ({ ...current, remarks: event.target.value }))} /></label>
              <div className="change-box">Calculated Net: <strong>{selectedSalaryRow ? money(selectedSalaryRow.net_salary) : '-'}</strong></div>
              <button className="primary-button compact-primary" type="submit">Save Salary Sheet</button>
            </form>
            <div className="change-box">
              Payslip search / view / print: use employee name or code, select date range, then print A4 payslip.
            </div>
            <form className="report-filter-row" onSubmit={loadPayslips}>
              <input
                className="field"
                value={payslipFilters.search}
                onChange={(event) => setPayslipFilters((current) => ({ ...current, search: event.target.value }))}
                placeholder="Employee name / code"
              />
              <input
                className="field report-date-input"
                type="date"
                value={normalizeDateInput(payslipFilters.from)}
                onChange={(event) => setPayslipFilters((current) => ({ ...current, from: event.target.value }))}
              />
              <input
                className="field report-date-input"
                type="date"
                value={normalizeDateInput(payslipFilters.to)}
                onChange={(event) => setPayslipFilters((current) => ({ ...current, to: event.target.value }))}
              />
              <button className="secondary-button" type="submit" disabled={isPayslipLoading}>
                {isPayslipLoading ? 'Loading...' : 'View Payslips'}
              </button>
            </form>
            {payslipRows.length > 0 && (
              <div className="table-scroll">
                <table className="history-table staff-payroll-table">
                  <thead><tr><th>Month</th><th>Emp Code</th><th>Name</th><th>Job</th><th>Present</th><th>Net Pay</th><th>Status</th><th>Action</th></tr></thead>
                  <tbody>{payslipRows.map((row) => (
                    <tr key={`${row.salary_month}-${row.staff.id}`}>
                      <td>{monthLabel(row.salary_month)}</td>
                      <td>{row.staff.staff_code || '-'}</td>
                      <td><strong>{row.staff.staff_name}</strong><br /><span className="muted">{row.staff.phone || '-'}</span></td>
                      <td>{row.staff.job_title || '-'}<br /><span className="muted">{row.staff.department || '-'}</span></td>
                      <td>{row.present_days}</td>
                      <td><strong>{money(row.net_salary)}</strong></td>
                      <td>{row.payment_status}{row.posted_to_cash_ledger ? ' / Posted' : ''}</td>
                      <td>
                        <div className="report-action-row">
                          <button className="secondary-button" type="button" onClick={() => viewPayslip(row)}>View A4</button>
                          <button className="secondary-button" type="button" onClick={() => printPayslip(row)}>Print A4</button>
                        </div>
                      </td>
                    </tr>
                  ))}</tbody>
                </table>
              </div>
            )}
            <div className="table-scroll">
              <table className="history-table staff-payroll-table">
                <thead><tr><th>Staff</th><th>Job</th><th>Present</th><th>Leave/Absent</th><th>Base</th><th>OT</th><th>DA</th><th>HRA</th><th>Bonus</th><th>Advance</th><th>PF</th><th>ESI</th><th>Deduction</th><th>Net</th><th>Status</th><th>Action</th></tr></thead>
                <tbody>{!salarySheet.rows?.length ? <tr><td colSpan="16">No staff for selected month.</td></tr> : salarySheet.rows.map((row) => (
                  <tr key={row.staff.id}>
                    <td>{row.staff.staff_name}<br /><span className="muted">{row.staff.phone}</span></td>
                    <td>{row.staff.job_title}<br /><span className="muted">{row.staff.department}</span></td>
                    <td>{row.present_days}</td>
                    <td>{row.paid_leave_days} / {row.absent_days}</td>
                    <td>{money(row.base_salary)}</td>
                    <td>{row.overtime_hours}h<br /><span className="muted">{money(row.overtime_amount)}</span></td>
                    <td>{money(row.da_amount)}</td>
                    <td>{money(row.hra_amount)}</td>
                    <td>{money(row.bonus_amount)}</td>
                    <td>{money(row.advance_amount)}</td>
                    <td>{money(row.pf_amount)}</td>
                    <td>{money(row.esi_amount)}</td>
                    <td>{money(row.deduction_amount)}</td>
                    <td><strong>{money(row.net_salary)}</strong></td>
                    <td>{row.payment_status}{row.posted_to_cash_ledger ? ' / Posted' : ''}</td>
                    <td>
                      <div className="report-action-row">
                        <button className="secondary-button" type="button" onClick={() => editSalary(row)}>Edit/Post</button>
                        <button className="secondary-button" type="button" onClick={() => viewPayslip(row)}>View A4</button>
                        <button className="secondary-button" type="button" onClick={() => printPayslip(row)}>Print A4</button>
                      </div>
                    </td>
                  </tr>
                ))}</tbody>
              </table>
            </div>
          </div>
        </section>
      )}

      {payslipPreviewHtml && (
        <div className="modal-backdrop">
          <div className="modal payslip-preview-modal">
            <div className="panel-header">
              <h2 className="panel-title">{payslipPreviewTitle || 'Payslip A4 Preview'}</h2>
              <div className="report-action-row">
                <button
                  className="secondary-button"
                  type="button"
                  onClick={() => {
                    const frameWindow = payslipFrameRef.current?.contentWindow;
                    frameWindow?.focus?.();
                    frameWindow?.print?.();
                  }}
                >
                  Print A4
                </button>
                <button className="close-action-button" type="button" onClick={() => setPayslipPreviewHtml('')}>Close</button>
              </div>
            </div>
            <iframe
              ref={payslipFrameRef}
              className="payslip-preview-frame"
              title={payslipPreviewTitle || 'Payslip A4 Preview'}
              srcDoc={payslipPreviewHtml}
            />
          </div>
        </div>
      )}
    </div>
  );
}
