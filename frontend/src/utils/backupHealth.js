// Keep local generation failures visible independently of cloud configuration.
export function backupAlerts(health, now = new Date()) {
  if (!health) return [];
  const sameDay = value => {
    const date = new Date(value);
    return value && date.getFullYear() === now.getFullYear() && date.getMonth() === now.getMonth() && date.getDate() === now.getDate();
  };
  const modern = typeof health.localStatus === 'string';
  const cloudEnabled = health.cloudEnabled ?? health.enabled !== false;
  const schedulerEnabled = modern ? health.enabled !== false : true;
  const time = /^(\d{2}):(\d{2})$/.exec(health.dailyTime || health.backup_daily_time || '09:00');
  const due = time ? Number(time[1]) * 60 + Number(time[2]) : 540;
  const overdue = schedulerEnabled && now.getHours() * 60 + now.getMinutes() >= due + 60;
  const day = `${now.getFullYear()}-${now.getMonth() + 1}-${now.getDate()}`;
  const alerts = [];
  const add = (channel, status, at, message, file = health.file) => {
    const name = channel === 'local' ? 'Local Backup' : 'Google Drive Backup';
    alerts.push({ channel, status, at, file, message,
      title: `${name} ${status === 'success' ? 'Successful' : status === 'failed' ? 'Failed' : 'Pending'}`,
      description: status === 'success' ? (channel === 'local' ? 'Today’s database backup was created locally.' : 'Today’s database backup was uploaded to Google Drive.') : (channel === 'local' ? 'The server needs attention to complete its local database backup.' : 'The local backup and Google Drive upload have separate status. Check the Drive connection.'),
      alertId: `daily-backup-${channel}-${status}-${status === 'success' ? (file || day) : `${day}-${at || 'pending'}`}` });
  };
  const localStatus = modern ? health.localStatus : (health.status === 'failed' && !cloudEnabled ? 'failed' : (health.latestLocalBackupAt ? 'success' : 'unknown'));
  const localAt = health.localAt || health.latestLocalBackupAt || health.at;
  if (localStatus === 'failed') add('local', 'failed', health.at || health.localAt, health.localMessage || health.message || 'Local backup failed. Check the folder permissions and available disk space.');
  else if (sameDay(health.latestLocalBackupAt || localAt) && localStatus === 'success' && !cloudEnabled) add('local', 'success', localAt, health.localMessage || 'Local backup completed. Google Drive is disabled.');
  else if (overdue && !sameDay(health.latestLocalBackupAt || (localStatus === 'success' ? localAt : null))) add('local', 'pending', localAt, 'No successful local backup was reported today. Check the backup schedule and server.');
  if (cloudEnabled) {
    const status = health.cloudStatus || (health.status === 'cloud-failed' ? 'failed' : health.status);
    const at = health.cloudAt || health.at;
    if (status === 'failed') add('cloud', 'failed', at, health.cloudMessage || health.message || 'Google Drive upload failed.');
    else if (status === 'success' && sameDay(health.latestSuccessAt || at)) add('cloud', 'success', health.latestSuccessAt || at, health.cloudMessage || 'Backup uploaded successfully.');
    else if (overdue) add('cloud', 'pending', at, health.cloudMessage || 'Google Drive upload has not completed today.');
  }
  return alerts.sort((a,b) => ({failed:0,pending:1,success:2}[a.status] - {failed:0,pending:1,success:2}[b.status]));
}

export function backupSettingsPayload(settings) {
  const drive = settings.backup_drive_enabled === true;
  const localKeep = Number(settings.backup_local_keep_count ?? 0);
  const driveKeep = Number(settings.backup_drive_keep_count ?? 3);
  if (!Number.isInteger(localKeep) || localKeep < 0 || !Number.isInteger(driveKeep) || driveKeep < 1) throw Error('Enter a whole-number retention count (local: 0 or more; Drive: 1 or more).');
  const folder = String(settings.backup_local_folder || '').trim();
  if (!folder) throw Error('Enter the backup folder on the server.');
  return { backup_daily_time: settings.backup_daily_time || '09:00', backup_local_folder: folder,
    backup_local_keep_count: localKeep, backup_drive_keep_count: driveKeep,
    backup_drive_enabled: drive, backup_keep_local: !drive || settings.backup_keep_local !== false };
}

// Defaults returned by GET must not become stored backup configuration when an
// unrelated shop/GST setting is saved. Backup controls have their own save action.
export function generalSettingsPayload(settings) {
  const backupKeys = new Set(['backup_local_folder', 'backup_local_keep_count', 'backup_drive_enabled', 'backup_keep_local', 'backup_drive_keep_count', 'backup_daily_time']);
  return Object.fromEntries(Object.entries(settings).filter(([key]) => !backupKeys.has(key)));
}

export function acknowledgedBackupAlerts(storage) {
  try { const items = JSON.parse(storage.getItem('badizo_backup_alert_acks') || '[]'); return Array.isArray(items) ? items.filter(item => typeof item === 'string') : []; } catch { return []; }
}
export function acknowledgeBackupAlert(storage, id) {
  storage.setItem('badizo_backup_alert_ack', id);
  storage.setItem('badizo_backup_alert_acks', JSON.stringify([...new Set([...acknowledgedBackupAlerts(storage), id])].slice(-30)));
}

export function backupHealthUnavailable(now = new Date()) {
  return {
    channel: 'status', status: 'unavailable', title: 'Backup Status Unavailable',
    description: 'The server did not return backup status. This does not confirm whether a backup succeeded or failed.',
    message: 'Check the server connection and ask the administrator to inspect backup settings and folder access.',
    alertId: `daily-backup-unavailable-${now.getFullYear()}-${now.getMonth() + 1}-${now.getDate()}`
  };
}
