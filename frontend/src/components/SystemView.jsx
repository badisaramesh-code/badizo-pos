import React, { useEffect, useMemo, useState } from 'react';
import {
  approveSensitiveBillingMode,
  downloadBackup,
  fetchAuditLogs,
  fetchBackups,
  fetchPasswordVault,
  fetchSessionEvents,
  fetchSettings,
  fetchSystemHealth,
  fetchUsers,
  restoreBackup,
  revealPasswordVaultSlot,
  runBackup,
  savePasswordVaultSlot,
  saveSettings,
  saveUser
} from '../api/client';

const emptyUserForm = {
  id: null,
  username: '',
  password: '',
  role: 'COUNTER',
  counter_no: 1,
  is_active: true
};

const PASSWORD_VAULT_FOLDERS = [
  {
    key: 'BADIZO_PRODUCT',
    label: 'Badizo Product Passwords',
    note: 'Software product, SQL/root, backend, support and designer-side passwords.'
  },
  {
    key: 'STORE_PROTECTED',
    label: 'Store Protected Passwords',
    note: 'Server/admin/counter operating passwords given to store.'
  }
];

const BARCODE_TEMPLATE_ROWS = [
  {
    key: 'tsc-244-pro-50x50-two-up.prn',
    label: '50 x 50 mm Two-Up'
  },
  {
    key: 'tsc-244-1-33x25-single.prn',
    label: '33 x 25 mm Two-Up'
  },
  {
    key: 'tsc-244-2-jewellery-100x15-tail.prn',
    label: '100 x 15 mm Jewellery Tail'
  }
];

const DEFAULT_BARCODE_PRINTER_TEMPLATES = {
  'tsc-244-pro-50x50-two-up.prn': {
    label: '50 x 50 mm Two-Up',
    printer: 'TSC TTP-244 Pro',
    shares: ['\\\\localhost\\TSC TTP-244 Pro', '\\\\localhost\\TSC-244-Pro']
  },
  'tsc-244-1-33x25-single.prn': {
    label: '33 x 25 mm Two-Up',
    printer: 'TSC TTP-244 -1',
    shares: ['\\\\localhost\\TSC TTP-244 -1', '\\\\localhost\\TSC 244-1']
  },
  'tsc-244-2-jewellery-100x15-tail.prn': {
    label: '100 x 15 mm Jewellery Tail',
    printer: 'TSC 244-2',
    shares: ['\\\\localhost\\TSC 244-2']
  }
};

export default function SystemView() {
  const [settings, setSettings] = useState({
    shop_name: 'Hyper Fresh Mart LLP',
    gst_number: '36AAJFH7790R1ZB',
    phone: '08761 295000',
    address: 'Sathupally - Khammam(dt) - 507303',
    bank_name: 'HDFC BANK',
    bank_account_name: 'Hyper Fresh Mart LLP',
    bank_account_no: '59209440987345',
    bank_ifsc: 'HDFC0004047',
    bank_branch: 'Sathupally',
    counter_count: 6,
    default_print_mode: 'Thermal',
    thermal_receipt_width_mm: 80,
    thermal_feed_margin_mm: 4,
    thermal_bill_logo_enabled: true,
    thermal_bill_logo_data_url: '',
    gst_slabs: '0,3,5,12,18,28,40',
    loyalty_enabled: false,
    loyalty_earn_sale_amount: 100,
    loyalty_earn_points: 10,
    loyalty_redeem_points: 10,
    loyalty_redeem_amount: 0.5,
    backup_daily_time: '09:00',
    barcode_printer_templates: DEFAULT_BARCODE_PRINTER_TEMPLATES
  });
  const [statusMessage, setStatusMessage] = useState('');
  const [errorMessage, setErrorMessage] = useState('');
  const [backupInfo, setBackupInfo] = useState({ backupDir: '', backups: [] });
  const [systemHealth, setSystemHealth] = useState(null);
  const [healthLoadError, setHealthLoadError] = useState('');
  const [isHealthLoading, setIsHealthLoading] = useState(false);
  const [auditLogs, setAuditLogs] = useState([]);
  const [sessionEvents, setSessionEvents] = useState({ rows: [], summary: [] });
  const [sessionFilters, setSessionFilters] = useState({ from: '', to: '', search: '' });
  const [users, setUsers] = useState([]);
  const [userForm, setUserForm] = useState(emptyUserForm);
  const [isBackingUp, setIsBackingUp] = useState(false);
  const [setupUnlocked, setSetupUnlocked] = useState(false);
  const [setupPassword, setSetupPassword] = useState({ username: '', password: '' });
  const [passwordVaultFolder, setPasswordVaultFolder] = useState('BADIZO_PRODUCT');
  const [passwordVault, setPasswordVault] = useState([]);
  const [visiblePasswords, setVisiblePasswords] = useState({});

  useEffect(() => {
    loadSettings();
    loadSystemHealth();
    loadBackups();
    loadAuditLogs();
    loadSessionEvents();
    loadUsers();
  }, []);

  const nodes = useMemo(() => {
    const counterCount = Number(settings.counter_count || 1);
    return [
      ['SERVER', 'Central Database SQL', 'ONLINE', 'Full data storage, backup, sync'],
      ['Admin 1', 'Full Access', 'CONNECTED', 'Products, inward, reports, books, settings'],
      ['Admin 2', 'Full Access', 'IDLE', 'Products, inward, reports, books, settings'],
      ...Array.from({ length: counterCount }, (_, index) => [
        `Counter ${index + 1}`,
        'Sales Only',
        index < 2 ? 'ACTIVE' : 'READY',
        'Billing, bill reprint, product search'
      ])
    ];
  }, [settings.counter_count]);

  async function loadSettings() {
    try {
      setSettings(await fetchSettings());
    } catch (err) {
      setErrorMessage('Unable to load settings.');
    }
  }

  async function loadBackups() {
    try {
      setBackupInfo(await fetchBackups());
    } catch (err) {
      setBackupInfo({ backupDir: '', backups: [] });
    }
  }

  async function loadAuditLogs() {
    try {
      setAuditLogs(await fetchAuditLogs(100));
    } catch (err) {
      setAuditLogs([]);
    }
  }

  async function loadSessionEvents(event, overrideFilters = null) {
    event?.preventDefault?.();
    const activeFilters = overrideFilters || sessionFilters;
    try {
      setSessionEvents(await fetchSessionEvents({
        limit: 500,
        from: activeFilters.from,
        to: activeFilters.to,
        search: activeFilters.search
      }));
    } catch (err) {
      setSessionEvents({ rows: [], summary: [] });
    }
  }

  async function loadUsers() {
    try {
      setUsers(await fetchUsers());
    } catch (err) {
      setUsers([]);
    }
  }

  function updateSetting(field, value) {
    setSettings((current) => ({ ...current, [field]: value }));
  }

  function handleThermalLogoUpload(event) {
    const file = event.target.files?.[0];
    event.target.value = '';
    setStatusMessage('');
    setErrorMessage('');
    if (!file) return;
    if (!/^image\/(png|jpeg|jpg|webp)$/i.test(file.type)) {
      setErrorMessage('Thermal bill logo must be PNG, JPG, or WebP.');
      return;
    }
    if (file.size > 512 * 1024) {
      setErrorMessage('Thermal bill logo is too large. Use a small 22mm x 22mm image under 512 KB.');
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      updateSetting('thermal_bill_logo_data_url', String(reader.result || ''));
      updateSetting('thermal_bill_logo_enabled', true);
      setStatusMessage('Thermal bill logo selected. Press Save Settings to apply.');
    };
    reader.onerror = () => setErrorMessage('Unable to read selected logo image.');
    reader.readAsDataURL(file);
  }

  function clearThermalLogo() {
    updateSetting('thermal_bill_logo_data_url', '');
    setStatusMessage('Thermal bill logo removed. Press Save Settings to apply.');
  }

  async function loadSystemHealth() {
    setIsHealthLoading(true);
    setHealthLoadError('');
    try {
      setSystemHealth(await fetchSystemHealth());
    } catch (err) {
      setSystemHealth(null);
      setHealthLoadError(err.response?.data?.error || 'Backend is not reachable on port 5000. Start the backend and press Refresh.');
    } finally {
      setIsHealthLoading(false);
    }
  }

  function updateBarcodePrinterTemplate(templateName, field, value) {
    setSettings((current) => {
      const currentTemplates = current.barcode_printer_templates || DEFAULT_BARCODE_PRINTER_TEMPLATES;
      const currentTemplate = currentTemplates[templateName] || DEFAULT_BARCODE_PRINTER_TEMPLATES[templateName] || {};
      return {
        ...current,
        barcode_printer_templates: {
          ...currentTemplates,
          [templateName]: {
            ...currentTemplate,
            label: currentTemplate.label || DEFAULT_BARCODE_PRINTER_TEMPLATES[templateName]?.label || templateName,
            [field]: field === 'shares'
              ? String(value || '').split(/\r?\n|,/).map((share) => share.trim()).filter(Boolean)
              : value
          }
        }
      };
    });
  }

  const storeName = settings.shop_name || 'Hyper Fresh Mart LLP';
  const storeGst = settings.gst_number || '36AAJFH7790R1ZB';
  const storeAddress = settings.address || 'Sathupally - Khammam(dt) - 507303';
  const storePhone = settings.phone || '08761 295000';

  async function handleSave() {
    setStatusMessage('');
    setErrorMessage('');

    try {
      const savedSettings = await saveSettings(settings);
      setSettings((current) => ({ ...current, ...savedSettings }));
      setSetupUnlocked(false);
      setSetupPassword({ username: '', password: '' });
      setStatusMessage('Settings saved. Setup folder closed. Thermal logo will print on the next bill.');
    } catch (err) {
      setErrorMessage(err.response?.data?.error || 'Unable to save settings.');
    }
  }

  async function unlockSetupFolder(event) {
    event.preventDefault();
    setStatusMessage('');
    setErrorMessage('');
    try {
      await approveSensitiveBillingMode({
        username: setupPassword.username,
        password: setupPassword.password,
        reason: 'Open password protected store setup folder'
      });
      setSetupUnlocked(true);
      setSetupPassword({ username: '', password: '' });
      setStatusMessage('Password protected setup folder opened.');
      await loadPasswordVault();
    } catch (err) {
      setErrorMessage(err.response?.data?.error || 'Admin password required to open setup folder.');
    }
  }

  async function loadPasswordVault(category = passwordVaultFolder) {
    try {
      const result = await fetchPasswordVault(category);
      const slots = result.slots || [];
      setPasswordVault(slots);
      setVisiblePasswords(slots.reduce((acc, slot) => (
        slot.has_password ? { ...acc, [slot.slot_no]: '********' } : acc
      ), {}));
    } catch (err) {
      setPasswordVault([]);
    }
  }

  async function changePasswordVaultFolder(category) {
    setPasswordVaultFolder(category);
    if (setupUnlocked) {
      await loadPasswordVault(category);
    }
  }

  function updateVaultSlot(slotNo, field, value) {
    setPasswordVault((current) => current.map((slot) => (
      Number(slot.slot_no) === Number(slotNo) ? { ...slot, [field]: value } : slot
    )));
  }

  async function saveVaultSlot(slot) {
    setStatusMessage('');
    setErrorMessage('');
    try {
      const password = slot.password_input || '';
      const saved = await savePasswordVaultSlot(slot.slot_no, {
        title: slot.title,
        username: slot.username,
        notes: slot.notes,
        password,
        update_password: Boolean(password)
      }, passwordVaultFolder);
      setPasswordVault((current) => current.map((item) => (
        Number(item.slot_no) === Number(slot.slot_no) ? { ...saved, password_input: '' } : item
      )));
      setVisiblePasswords((current) => ({ ...current, [slot.slot_no]: saved.has_password ? '********' : undefined }));
      setStatusMessage(`Password slot ${slot.slot_no} saved.`);
    } catch (err) {
      setErrorMessage(err.response?.data?.error || 'Unable to save password slot.');
    }
  }

  async function revealVaultPassword(slotNo) {
    setStatusMessage('');
    setErrorMessage('');
    try {
      const result = await revealPasswordVaultSlot(slotNo, passwordVaultFolder);
      setVisiblePasswords((current) => ({ ...current, [slotNo]: result.password || '' }));
    } catch (err) {
      setErrorMessage(err.response?.data?.error || 'Unable to view password.');
    }
  }

  async function handleBackupNow() {
    const confirmed = window.confirm('Create a database backup now? Keep this file safe on an external drive also.');
    if (!confirmed) return;

    setStatusMessage('');
    setErrorMessage('');
    setIsBackingUp(true);

    try {
      const result = await runBackup();
      const cloudBackup = result.backup?.cloudBackup;
      if (cloudBackup?.enabled && cloudBackup?.uploaded) {
        setStatusMessage(`Backup created and uploaded to Google Drive: ${result.backup.file}`);
      } else if (cloudBackup?.enabled && cloudBackup?.error) {
        setStatusMessage(`Local backup created: ${result.backup.file}. Google Drive upload failed: ${cloudBackup.error}`);
      } else {
        setStatusMessage(`Backup created: ${result.backup.file}`);
      }
      await loadBackups();
    } catch (err) {
      setErrorMessage(err.response?.data?.error || 'Unable to create backup.');
    } finally {
      setIsBackingUp(false);
    }
  }

  async function handleRestoreBackup(file) {
    const confirmation = window.prompt(`Restore ${file}? This can overwrite current data. Type RESTORE BADIZO POS to continue.`);
    if (confirmation !== 'RESTORE BADIZO POS') return;

    setStatusMessage('');
    setErrorMessage('');
    try {
      await restoreBackup(file, confirmation);
      setStatusMessage(`Backup restored from ${file}. Restart backend and refresh all counters.`);
      await loadAuditLogs();
    } catch (err) {
      setErrorMessage(err.response?.data?.error || 'Unable to restore backup.');
    }
  }

  function editUser(user) {
    setUserForm({
      id: user.id,
      username: user.username,
      password: '',
      role: user.role,
      counter_no: user.counter_no || 1,
      is_active: Boolean(user.is_active)
    });
  }

  async function handleUserSave() {
    setStatusMessage('');
    setErrorMessage('');

    try {
      await saveUser(userForm);
      setStatusMessage(`${userForm.username} saved.`);
      setUserForm(emptyUserForm);
      await loadUsers();
      await loadAuditLogs();
    } catch (err) {
      setErrorMessage(err.response?.data?.error || 'Unable to save user.');
    }
  }

  function formatBytes(bytes) {
    const value = Number(bytes || 0);
    if (value < 1024) return `${value} B`;
    if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
    if (value < 1024 * 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(1)} MB`;
    return `${(value / (1024 * 1024 * 1024)).toFixed(1)} GB`;
  }

  async function handleSaveBackupTime() {
    setStatusMessage('');
    setErrorMessage('');
    try {
      const savedSettings = await saveSettings({ backup_daily_time: settings.backup_daily_time || '09:00' });
      setSettings((current) => ({ ...current, ...savedSettings }));
      setStatusMessage('Backup time saved. Restart backend once for the daily scheduler to use the new time.');
    } catch (err) {
      setErrorMessage(err.response?.data?.error || 'Unable to save backup time.');
    }
  }

  function formatHealthDate(value) {
    return value ? new Date(value).toLocaleString() : '-';
  }

  function healthChip(ok, goodText = 'OK', badText = 'Needs Check', pendingText = 'Waiting', badClass = 'danger') {
    if (ok === undefined || ok === null) {
      return <span className="status-chip muted">{pendingText}</span>;
    }
    return <span className={`status-chip ${ok ? 'success' : badClass}`}>{ok ? goodText : badText}</span>;
  }

  return (
    <div className="form-stack">
      <section className="panel">
        <div className="panel-header green"><h2 className="panel-title">Network Architecture - Badizo POS System</h2></div>
        <div className="panel-body system-grid">
          {nodes.map(([name, role, status, note]) => (
            <div className="module-card" key={name}>
              <strong>{name}</strong>
              <span>{role}</span>
              <span className={status === 'OFFLINE' ? 'stock-low' : 'status-chip'}>{status}</span>
              <span className="muted">{note}</span>
            </div>
          ))}
        </div>
      </section>

      <section className="panel">
        <div className="panel-header green">
          <div>
            <h2 className="panel-title">System Health</h2>
            <span className="panel-subtitle">Server, database, backup, disk, printer, IP and log check</span>
          </div>
          <button className="secondary-button" type="button" onClick={loadSystemHealth} disabled={isHealthLoading}>
            {isHealthLoading ? 'Checking...' : 'Refresh'}
          </button>
        </div>
        <div className="panel-body form-stack">
          {healthLoadError && <div className="alert-box">{healthLoadError}</div>}
          <div className="health-summary-grid">
            <div className="health-card">
              <span className="field-label">Backend</span>
              {healthChip(systemHealth?.backend?.ok, 'Running', 'Offline')}
              <strong>Port {systemHealth?.backend?.port || 5000}</strong>
              <span className="muted">{systemHealth?.backend?.error || `Uptime: ${systemHealth?.backend?.uptimeSeconds ? `${Math.floor(systemHealth.backend.uptimeSeconds / 60)} min` : '-'}`}</span>
            </div>
            <div className="health-card">
              <span className="field-label">MySQL</span>
              {healthChip(systemHealth?.mysql?.ok, 'Connected', 'Error')}
              <strong>{systemHealth?.mysql?.database || 'badizo_pos'}</strong>
              <span className="muted">{systemHealth?.mysql?.version || systemHealth?.mysql?.error || '-'}</span>
            </div>
            <div className="health-card">
              <span className="field-label">Last Backup</span>
              {healthChip(systemHealth?.backup?.ok, 'Available', 'Missing')}
              <strong>{systemHealth?.backup?.lastBackup?.file || 'No backup yet'}</strong>
              <span className="muted">{formatHealthDate(systemHealth?.backup?.lastBackup?.modifiedAt)}</span>
            </div>
            <div className="health-card">
              <span className="field-label">Disk Space</span>
              {healthChip(systemHealth?.disk?.ok === undefined ? null : systemHealth?.disk?.ok && Number(systemHealth?.disk?.usedPercent || 0) < 90, 'Healthy', 'Check')}
              <strong>{systemHealth?.disk?.freeBytes ? `${formatBytes(systemHealth.disk.freeBytes)} free` : '-'}</strong>
              <span className="muted">{systemHealth?.disk?.usedPercent ?? '-'}% used on {systemHealth?.disk?.path || '-'}</span>
            </div>
            <div className="health-card">
              <span className="field-label">Server IP</span>
              {healthChip(systemHealth?.network ? Boolean(systemHealth.network.serverIps?.length) : null, 'Found', 'Missing')}
              <strong className="mono">{systemHealth?.network?.serverIps?.[0] || 'localhost'}</strong>
              <span className="muted">API port {systemHealth?.network?.port || 5000}: {systemHealth?.network?.portReachable ? 'reachable' : 'not reachable'}</span>
            </div>
            <div className="health-card">
              <span className="field-label">Printers</span>
              {healthChip(systemHealth?.printers?.ok, 'Detected', 'Permission Note', 'Waiting', 'warning')}
              <strong>{systemHealth?.printers?.printers?.length || 0} Windows printers</strong>
              <span className="muted">{systemHealth?.printers?.error || systemHealth?.printers?.note || 'Default/status depends on Windows printer setup.'}</span>
            </div>
          </div>

          <div className="change-box health-network-box">
            <span>Checked: <strong>{formatHealthDate(systemHealth?.checkedAt)}</strong></span>
            <span>Browser URL from slave machines: <strong className="mono">{systemHealth?.network?.serverIps?.[0] ? `http://${systemHealth.network.serverIps[0]}:3000` : 'http://SERVER-IP:3000'}</strong></span>
            <span>API URL: <strong className="mono">{systemHealth?.network?.serverIps?.[0] ? `http://${systemHealth.network.serverIps[0]}:5000/api` : 'http://SERVER-IP:5000/api'}</strong></span>
          </div>

          <div className="table-scroll">
            <table className="history-table health-detail-table">
              <thead><tr><th>Area</th><th>Status / Detail</th><th>Path / Note</th></tr></thead>
              <tbody>
                {(systemHealth?.logs || []).map((log) => (
                  <tr key={log.path}>
                    <td>{log.label}</td>
                    <td>{log.exists ? `${formatBytes(log.sizeBytes)} | ${formatHealthDate(log.modifiedAt)}` : 'Not created yet'}</td>
                    <td className="mono">{log.path}</td>
                  </tr>
                ))}
                {(systemHealth?.printers?.printers || []).slice(0, 8).map((printer) => (
                  <tr key={`${printer.Name}-${printer.PortName}`}>
                    <td>{printer.Name}</td>
                    <td>{printer.PrinterStatus || '-'}{printer.Default ? ' | Default' : ''}{printer.Shared ? ' | Shared' : ''}</td>
                    <td className="mono">{printer.ShareName ? `\\\\localhost\\${printer.ShareName}` : (printer.PortName || printer.DriverName || '-')}</td>
                  </tr>
                ))}
                {!systemHealth && (
                  <tr><td colSpan="3">Press Refresh to load system health.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      </section>

      <section className="system-grid">
        <div className={`panel ${setupUnlocked ? 'setup-folder-panel' : ''}`}>
          <div className="panel-header green"><h2 className="panel-title">Password Protected Store Setup Folder</h2></div>
          <div className="panel-body form-stack">
            {errorMessage && <div className="alert-box">{errorMessage}</div>}
            {statusMessage && <div className="change-box">{statusMessage}</div>}

            {!setupUnlocked ? (
              <form className="form-stack" onSubmit={unlockSetupFolder}>
                <div className="alert-box">
                  Store name, POS/A4 bill heading, bank details, counter closing sheet heading, counters and user passwords are protected here.
                </div>
                <label>
                  <span className="field-label">Admin Username</span>
                  <input className="field" value={setupPassword.username} onChange={(event) => setSetupPassword((current) => ({ ...current, username: event.target.value }))} autoComplete="username" />
                </label>
                <label>
                  <span className="field-label">Password</span>
                  <input className="field" type="password" value={setupPassword.password} onChange={(event) => setSetupPassword((current) => ({ ...current, password: event.target.value }))} autoComplete="current-password" />
                </label>
                <button className="primary-button" type="submit">Open Setup Folder</button>
              </form>
            ) : (
            <>
            <div className="settings-section">
              <div className="settings-section-title">Store Details</div>
              <label><span className="field-label">Shop Name</span><input className="field" value={settings.shop_name || ''} onChange={(event) => updateSetting('shop_name', event.target.value)} /></label>
              <label><span className="field-label">GST Number</span><input className="field" value={settings.gst_number || ''} onChange={(event) => updateSetting('gst_number', event.target.value.toUpperCase())} /></label>
              <label><span className="field-label">Phone</span><input className="field" value={settings.phone || ''} onChange={(event) => updateSetting('phone', event.target.value)} /></label>
              <label><span className="field-label">Address</span><textarea className="field settings-address-field" rows="2" value={settings.address || ''} onChange={(event) => updateSetting('address', event.target.value)} /></label>
              <div className="pos-header-preview">
                <strong>{storeName}</strong>
                <span>GST: {storeGst} | {storeAddress} | Ph: {storePhone}</span>
              </div>
              <div className="thermal-logo-settings">
                <div className="thermal-logo-preview-box">
                  {settings.thermal_bill_logo_data_url ? (
                    <img src={settings.thermal_bill_logo_data_url} alt="Thermal bill logo preview" />
                  ) : (
                    <span>No Logo</span>
                  )}
                </div>
                <div className="thermal-logo-controls">
                  <label className="checkbox-row">
                    <input
                      type="checkbox"
                      checked={settings.thermal_bill_logo_enabled !== false && settings.thermal_bill_logo_enabled !== '0'}
                      onChange={(event) => updateSetting('thermal_bill_logo_enabled', event.target.checked)}
                    />
                    <span>Print logo in 25mm thermal bill top space</span>
                  </label>
                  <label>
                    <span className="field-label">Thermal Bill Logo</span>
                    <input className="field" type="file" accept="image/png,image/jpeg,image/webp" onChange={handleThermalLogoUpload} />
                  </label>
                  <div className="settings-action-row">
                    <button className="secondary-button" type="button" onClick={clearThermalLogo} disabled={!settings.thermal_bill_logo_data_url}>Remove Logo</button>
                    <span className="muted">Use a square 22mm x 22mm image. Save settings after upload.</span>
                  </div>
                </div>
              </div>
            </div>

            <div className="settings-section">
              <div className="settings-section-title">A4 Invoice / Bank Details</div>
              <label><span className="field-label">Bank Name</span><input className="field" value={settings.bank_name || ''} onChange={(event) => updateSetting('bank_name', event.target.value)} /></label>
              <label><span className="field-label">Bank Account Name</span><input className="field" value={settings.bank_account_name || ''} onChange={(event) => updateSetting('bank_account_name', event.target.value)} /></label>
              <label><span className="field-label">Bank Account No</span><input className="field" value={settings.bank_account_no || ''} onChange={(event) => updateSetting('bank_account_no', event.target.value)} /></label>
              <label><span className="field-label">Bank IFSC</span><input className="field" value={settings.bank_ifsc || ''} onChange={(event) => updateSetting('bank_ifsc', event.target.value.toUpperCase())} /></label>
              <label><span className="field-label">Bank Branch</span><input className="field" value={settings.bank_branch || ''} onChange={(event) => updateSetting('bank_branch', event.target.value)} /></label>
            </div>

            <div className="settings-section settings-inline-section">
              <label>
                <span className="field-label">Billing Counters</span>
                <input
                  className="field"
                  type="number"
                  min="1"
                  max="99"
                  value={settings.counter_count || 1}
                  onChange={(event) => updateSetting('counter_count', event.target.value)}
                />
              </label>
              <label>
                <span className="field-label">Default Print</span>
                <select
                  className="select"
                  value={settings.default_print_mode || 'Thermal'}
                  onChange={(event) => updateSetting('default_print_mode', event.target.value)}
                >
                  <option value="Thermal">Thermal receipt</option>
                  <option value="A4">A4 invoice</option>
                </select>
              </label>
              <label>
                <span className="field-label">Thermal Width</span>
                <select
                  className="select"
                  value={settings.thermal_receipt_width_mm || 80}
                  onChange={(event) => updateSetting('thermal_receipt_width_mm', event.target.value)}
                >
                  <option value="58">58 mm</option>
                  <option value="60">60 mm</option>
                  <option value="72">72 mm</option>
                  <option value="76">76 mm</option>
                  <option value="80">80 mm</option>
                  <option value="82">82 mm</option>
                  <option value="85">85 mm</option>
                  <option value="90">90 mm</option>
                </select>
              </label>
              <label>
                <span className="field-label">Thermal Feed Margin</span>
                <input
                  className="field"
                  type="number"
                  min="0"
                  max="30"
                  value={settings.thermal_feed_margin_mm ?? 4}
                  onChange={(event) => updateSetting('thermal_feed_margin_mm', event.target.value)}
                />
              </label>
              <label>
                <span className="field-label">GST Slabs</span>
                <input
                  className="field"
                  value={settings.gst_slabs || ''}
                  onChange={(event) => updateSetting('gst_slabs', event.target.value)}
                  placeholder="0,3,5,12,18,28,40"
                />
              </label>
            </div>
            <div className="settings-section settings-inline-section">
              <div className="settings-section-title">Loyalty Points</div>
              <label className="checkbox-line">
                <input
                  type="checkbox"
                  checked={settings.loyalty_enabled === true || settings.loyalty_enabled === '1'}
                  onChange={(event) => updateSetting('loyalty_enabled', event.target.checked)}
                />
                <span>Enable loyalty points earn/redeem</span>
              </label>
              <label>
                <span className="field-label">Sale Amount</span>
                <input
                  className="field"
                  type="number"
                  min="1"
                  step="0.01"
                  value={settings.loyalty_earn_sale_amount || 100}
                  onChange={(event) => updateSetting('loyalty_earn_sale_amount', event.target.value)}
                />
              </label>
              <label>
                <span className="field-label">Earn Points</span>
                <input
                  className="field"
                  type="number"
                  min="1"
                  step="1"
                  value={settings.loyalty_earn_points || 10}
                  onChange={(event) => updateSetting('loyalty_earn_points', event.target.value)}
                />
              </label>
              <label>
                <span className="field-label">Redeem Points</span>
                <input
                  className="field"
                  type="number"
                  min="1"
                  step="1"
                  value={settings.loyalty_redeem_points || 10}
                  onChange={(event) => updateSetting('loyalty_redeem_points', event.target.value)}
                />
              </label>
              <label>
                <span className="field-label">Redeem Value Rs</span>
                <input
                  className="field"
                  type="number"
                  min="0.01"
                  step="0.01"
                  value={settings.loyalty_redeem_amount || 0.5}
                  onChange={(event) => updateSetting('loyalty_redeem_amount', event.target.value)}
                />
              </label>
              <div className="change-box">
                Example: Sale Amount 100, Earn Points 10 means Rs.100 sale ki 10 points. Redeem Points 10, Redeem Value Rs 0.50 means 10000 points = Rs.500.
              </div>
            </div>
            <div className="settings-section">
              <div className="settings-section-title">Barcode Sticker Printers</div>
              <div className="change-box">
                Each sticker size can print to a different Windows shared printer. Use one share path per line, for example \\localhost\TSC TTP-244 -1.
              </div>
              <div className="table-scroll">
                <table className="history-table barcode-printer-settings-table">
                  <thead>
                    <tr>
                      <th>Sticker Size</th>
                      <th>Printer Name</th>
                      <th>Windows Share Path</th>
                    </tr>
                  </thead>
                  <tbody>
                    {BARCODE_TEMPLATE_ROWS.map((template) => {
                      const config = settings.barcode_printer_templates?.[template.key]
                        || DEFAULT_BARCODE_PRINTER_TEMPLATES[template.key]
                        || {};
                      return (
                        <tr key={template.key}>
                          <td>
                            <strong>{config.label || template.label}</strong>
                            <span className="muted mono">{template.key}</span>
                          </td>
                          <td>
                            <input
                              className="field"
                              value={config.printer || ''}
                              onChange={(event) => updateBarcodePrinterTemplate(template.key, 'printer', event.target.value)}
                              placeholder="Windows printer name"
                            />
                          </td>
                          <td>
                            <textarea
                              className="field barcode-share-field"
                              rows="2"
                              value={(config.shares || []).join('\n')}
                              onChange={(event) => updateBarcodePrinterTemplate(template.key, 'shares', event.target.value)}
                              placeholder="\\localhost\Printer Share Name"
                            />
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
            <button className="primary-button" onClick={handleSave}>Save Settings</button>
            <button className="secondary-button" type="button" onClick={() => setSetupUnlocked(false)}>Close Setup Folder</button>

            <div className="settings-section">
              <div className="settings-section-title">Password Protected Files</div>
              <div className="alert-box">
                Badizo product passwords and store operating passwords are stored separately. Password value is shown only after pressing View.
              </div>
              <div className="password-folder-tabs">
                {PASSWORD_VAULT_FOLDERS.map((folder) => (
                  <button
                    key={folder.key}
                    className={`password-folder-tab ${passwordVaultFolder === folder.key ? 'active' : ''}`}
                    type="button"
                    onClick={() => changePasswordVaultFolder(folder.key)}
                  >
                    <strong>{folder.label}</strong>
                    <span>{folder.note}</span>
                  </button>
                ))}
              </div>
              <div className="change-box">
                Current file: <strong>{PASSWORD_VAULT_FOLDERS.find((folder) => folder.key === passwordVaultFolder)?.label}</strong> - 10 password slots.
              </div>
              <div className="table-scroll">
                <table className="history-table password-vault-table">
                  <thead>
                    <tr>
                      <th>No</th>
                      <th>Detail</th>
                      <th>User / Login</th>
                      <th>Password</th>
                      <th>New Password</th>
                      <th>Notes</th>
                      <th>Action</th>
                    </tr>
                  </thead>
                  <tbody>
                    {passwordVault.length === 0 ? (
                      <tr><td colSpan="7">Open setup folder to load password vault.</td></tr>
                    ) : passwordVault.map((slot) => (
                      <tr key={slot.slot_no}>
                        <td>{slot.slot_no}</td>
                        <td>
                          <input
                            className="field"
                            value={slot.title || ''}
                            onChange={(event) => updateVaultSlot(slot.slot_no, 'title', event.target.value)}
                            placeholder={slot.slot_no === 1 ? 'SQL Root Password' : 'Password detail'}
                          />
                        </td>
                        <td>
                          <input
                            className="field"
                            value={slot.username || ''}
                            onChange={(event) => updateVaultSlot(slot.slot_no, 'username', event.target.value)}
                            placeholder={slot.slot_no === 1 ? 'root' : 'Username'}
                          />
                        </td>
                        <td className="password-vault-secret">
                          <span className="mono">
                            {visiblePasswords[slot.slot_no] !== undefined
                              ? (visiblePasswords[slot.slot_no] || '(empty)')
                              : (slot.has_password ? '••••••••' : 'Not saved')}
                          </span>
                          <button className="secondary-button" type="button" onClick={() => revealVaultPassword(slot.slot_no)} disabled={!slot.has_password}>View</button>
                        </td>
                        <td>
                          <input
                            className="field"
                            type="password"
                            value={slot.password_input || ''}
                            onChange={(event) => updateVaultSlot(slot.slot_no, 'password_input', event.target.value)}
                            placeholder="Enter to change"
                          />
                        </td>
                        <td>
                          <input
                            className="field"
                            value={slot.notes || ''}
                            onChange={(event) => updateVaultSlot(slot.slot_no, 'notes', event.target.value)}
                            placeholder="Where used"
                          />
                        </td>
                        <td><button className="primary-button compact-primary" type="button" onClick={() => saveVaultSlot(slot)}>Save</button></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
            </>
            )}
          </div>
        </div>

        {setupUnlocked && (
        <div className="panel">
          <div className="panel-header green"><h2 className="panel-title">User Management</h2></div>
          <div className="panel-body form-stack">
            <div className="user-form-grid">
              <input
                className="field"
                value={userForm.username}
                onChange={(event) => setUserForm((current) => ({ ...current, username: event.target.value }))}
                placeholder="Username"
              />
              <input
                className="field"
                type="password"
                value={userForm.password}
                onChange={(event) => setUserForm((current) => ({ ...current, password: event.target.value }))}
                placeholder={userForm.id ? 'New password optional' : 'Password'}
              />
              <select
                className="select"
                value={userForm.role}
                onChange={(event) => setUserForm((current) => ({ ...current, role: event.target.value }))}
              >
                <option value="SERVER">Server</option>
                <option value="ADMIN">Admin</option>
                <option value="COUNTER">Counter</option>
                <option value="SECURITY">Security</option>
              </select>
              <input
                className="field"
                type="number"
                min="1"
                max="99"
                value={userForm.counter_no || 1}
                disabled={userForm.role !== 'COUNTER'}
                onChange={(event) => setUserForm((current) => ({ ...current, counter_no: event.target.value }))}
                placeholder="Counter no"
              />
              <label className="change-box">
                <input
                  type="checkbox"
                  checked={userForm.is_active}
                  onChange={(event) => setUserForm((current) => ({ ...current, is_active: event.target.checked }))}
                /> Active
              </label>
              <button className="secondary-button" onClick={() => setUserForm(emptyUserForm)}>Clear</button>
              <button className="primary-button compact-primary" onClick={handleUserSave}>Save User</button>
            </div>
            <table className="history-table">
              <thead><tr><th>User</th><th>Role</th><th>Status</th><th>Actions</th></tr></thead>
              <tbody>
                {users.length === 0 ? (
                  <tr><td colSpan="4">No users loaded.</td></tr>
                ) : users.map((user) => (
                  <tr key={user.id}>
                    <td>{user.username}</td>
                    <td>{user.role}{user.counter_no ? ` ${user.counter_no}` : ''}</td>
                    <td>{user.is_active ? 'Active' : 'Inactive'}</td>
                    <td><button className="secondary-button" onClick={() => editUser(user)}>Edit</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
        )}

        <div className="panel">
          <div className="panel-header green">
            <h2 className="panel-title">Database Backup</h2>
            <button className="secondary-button" onClick={loadBackups}>Refresh</button>
          </div>
          <div className="panel-body form-stack">
            <div className="change-box backup-folder-box">
              <span>Daily backup runs at <strong>{settings.backup_daily_time || '09:00'}</strong>.</span>
              <span>Backup folder: <strong>{backupInfo.backupDir || 'backend/backups'}</strong></span>
            </div>
            <div className="settings-section settings-inline-section">
              <label>
                <span className="field-label">Daily Backup Time</span>
                <input
                  className="field"
                  type="time"
                  value={settings.backup_daily_time || '09:00'}
                  onChange={(event) => updateSetting('backup_daily_time', event.target.value)}
                />
              </label>
              <button className="secondary-button" type="button" onClick={handleSaveBackupTime}>Save Backup Time</button>
            </div>
            <button className="primary-button" onClick={handleBackupNow} disabled={isBackingUp}>
              {isBackingUp ? 'Creating Backup...' : 'Backup Now'}
            </button>

            <table className="history-table">
              <thead><tr><th>Backup File</th><th>Size</th><th>Created</th><th>Action</th></tr></thead>
              <tbody>
                {backupInfo.backups.length === 0 ? (
                  <tr><td colSpan="4">No backups created yet.</td></tr>
                ) : (
                  backupInfo.backups.slice(0, 8).map((backup) => (
                    <tr key={backup.file}>
                      <td className="mono">{backup.file}</td>
                      <td>{formatBytes(backup.sizeBytes)}</td>
                      <td>{backup.modifiedAt ? new Date(backup.modifiedAt).toLocaleString() : '-'}</td>
                      <td>
                        <div className="table-actions">
                          <button className="secondary-button" onClick={() => downloadBackup(backup.file)}>Download</button>
                          <button className="danger-button" onClick={() => handleRestoreBackup(backup.file)}>Restore</button>
                        </div>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>

        <div className="panel">
          <div className="panel-header green"><h2 className="panel-title">Production Checklist</h2></div>
          <div className="panel-body form-stack">
            <div className="change-box">SQL server connection required</div>
            <div className="change-box">Counter count is configurable per shop</div>
            <div className="change-box">Role permissions: Server, Admin, Counter</div>
            <div className="change-box">Daily backup and restore testing</div>
            <div className="change-box">Thermal printer and TSC barcode printer mapping</div>
          </div>
        </div>
      </section>

      <section className="panel">
        <div className="panel-header green">
          <div>
            <h2 className="panel-title">Login Records Folder</h2>
            <span className="panel-subtitle">Every admin, counter and security login/logout record with date and time</span>
          </div>
          <button className="secondary-button" onClick={loadSessionEvents}>Refresh</button>
        </div>
        <div className="panel-body form-stack">
          <form className="settings-section settings-inline-section" onSubmit={loadSessionEvents}>
            <label>
              <span className="field-label">From Date</span>
              <input
                className="field"
                type="date"
                value={sessionFilters.from}
                onChange={(event) => setSessionFilters((current) => ({ ...current, from: event.target.value }))}
              />
            </label>
            <label>
              <span className="field-label">To Date</span>
              <input
                className="field"
                type="date"
                value={sessionFilters.to}
                onChange={(event) => setSessionFilters((current) => ({ ...current, to: event.target.value }))}
              />
            </label>
            <label>
              <span className="field-label">Search Login Records</span>
              <input
                className="field"
                value={sessionFilters.search}
                onChange={(event) => setSessionFilters((current) => ({ ...current, search: event.target.value }))}
                placeholder="Search person, user, role, counter, login/logout, IP or time"
              />
            </label>
            <button className="secondary-button" type="submit">Search</button>
            <button
              className="secondary-button"
              type="button"
              onClick={() => {
                const clearedFilters = { from: '', to: '', search: '' };
                setSessionFilters(clearedFilters);
                loadSessionEvents(null, clearedFilters);
              }}
            >
              Clear
            </button>
            <div className="change-box">
              Showing <strong>{sessionEvents.rows.length}</strong> latest matching records.
            </div>
          </form>

          <div className="table-scroll">
            <table className="history-table">
              <thead><tr><th>Time</th><th>User</th><th>Person Name</th><th>Role</th><th>Counter</th><th>Event</th><th>IP Address</th><th>Device</th></tr></thead>
              <tbody>
                {sessionEvents.rows.length === 0 ? (
                  <tr><td colSpan="8">No login/logout records yet.</td></tr>
                ) : (
                  sessionEvents.rows.map((event) => (
                    <tr key={event.id}>
                      <td>{event.created_at ? new Date(event.created_at).toLocaleString() : '-'}</td>
                      <td>{event.username}</td>
                      <td>{event.person_name || '-'}</td>
                      <td>{event.role}</td>
                      <td>{event.counter_no || '-'}</td>
                      <td><span className={`status-chip ${event.event_type === 'LOGIN' ? 'success' : 'muted'}`}>{event.event_type}</span></td>
                      <td className="mono">{event.ip_address || '-'}</td>
                      <td className="mono">{event.user_agent || '-'}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      </section>

      <section className="panel">
        <div className="panel-header green">
          <h2 className="panel-title">Audit Log</h2>
          <button className="secondary-button" onClick={loadAuditLogs}>Refresh</button>
        </div>
        <div className="panel-body">
          <table className="history-table">
            <thead><tr><th>Time</th><th>User</th><th>Role</th><th>Action</th><th>Entity</th><th>Details</th></tr></thead>
            <tbody>
              {auditLogs.length === 0 ? (
                <tr><td colSpan="6">No audit activity yet.</td></tr>
              ) : (
                auditLogs.map((log) => (
                  <tr key={log.id}>
                    <td>{log.created_at ? new Date(log.created_at).toLocaleString() : '-'}</td>
                    <td>{log.username}</td>
                    <td>{log.role}</td>
                    <td>{log.action}</td>
                    <td>{log.entity_type} {log.entity_id || ''}</td>
                    <td className="mono">{log.details ? JSON.stringify(log.details) : '-'}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
