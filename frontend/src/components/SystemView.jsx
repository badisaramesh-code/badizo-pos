import React, { useEffect, useMemo, useState } from 'react';
import {
  approveSensitiveBillingMode,
  downloadBackup,
  fetchAuditLogs,
  fetchBackups,
  fetchPasswordVault,
  fetchSettings,
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
    default_print_mode: 'Thermal'
  });
  const [statusMessage, setStatusMessage] = useState('');
  const [errorMessage, setErrorMessage] = useState('');
  const [backupInfo, setBackupInfo] = useState({ backupDir: '', backups: [] });
  const [auditLogs, setAuditLogs] = useState([]);
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
    loadBackups();
    loadAuditLogs();
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
      setStatusMessage('Settings saved. Restart or refresh counters to apply the new counter list.');
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
      setStatusMessage(`Backup created: ${result.backup.file}`);
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
    return `${(value / (1024 * 1024)).toFixed(1)} MB`;
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
              <span>Daily backup runs at 10:30 PM by default.</span>
              <span>Backup folder: <strong>{backupInfo.backupDir || 'backend/backups'}</strong></span>
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
