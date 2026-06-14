const express = require('express');
const fs = require('fs');
const router = express.Router();
const { authenticate, authorize } = require('../middleware/auth');
const {
  backupDir,
  getBackupPath,
  listBackups,
  restoreDatabaseBackup,
  runDatabaseBackup
} = require('../services/backupService');
const { writeAuditLog } = require('../services/auditService');
const { logError, logInfo } = require('../services/logger');

router.use(authenticate, authorize('SERVER', 'ADMIN'));

router.get('/', async (_req, res) => {
  try {
    res.json({
      backupDir,
      backups: await listBackups()
    });
  } catch (err) {
    console.error('Backup list failed:', err.message);
    logError('Backup list failed', err);
    res.status(500).json({ error: 'Unable to list backups.' });
  }
});

router.post('/run', async (req, res) => {
  try {
    const backup = await runDatabaseBackup();
    logInfo('Manual backup created', { file: backup.file, sizeBytes: backup.sizeBytes, user: req.user?.username || '' });
    await writeAuditLog({
      user: req.user,
      action: 'BACKUP_CREATED',
      entityType: 'BACKUP',
      entityId: backup.file,
      details: { file: backup.file, sizeBytes: backup.sizeBytes }
    });
    res.json({
      success: true,
      backup
    });
  } catch (err) {
    console.error('Backup failed:', err.message);
    logError('Backup failed', err, { user: req.user?.username || '' });
    res.status(500).json({ error: err.message || 'Unable to create backup.' });
  }
});

router.get('/download/:file', async (req, res) => {
  try {
    const filePath = getBackupPath(req.params.file);
    if (!filePath || !fs.existsSync(filePath)) {
      return res.status(404).json({ error: 'Backup file not found.' });
    }

    res.download(filePath);
  } catch (err) {
    console.error('Backup download failed:', err.message);
    logError('Backup download failed', err, { file: req.params?.file, user: req.user?.username || '' });
    res.status(500).json({ error: 'Unable to download backup.' });
  }
});

router.post('/restore', async (req, res) => {
  const file = String(req.body?.file || '').trim();
  const confirmation = String(req.body?.confirmation || '').trim();

  if (confirmation !== 'RESTORE BADIZO POS') {
    return res.status(400).json({ error: 'Restore confirmation text is required.' });
  }

  try {
    const result = await restoreDatabaseBackup(file);
    await writeAuditLog({
      user: req.user,
      action: 'BACKUP_RESTORED',
      entityType: 'BACKUP',
      entityId: result.file,
      details: { file: result.file }
    });
    res.json({ success: true, restore: result });
  } catch (err) {
    console.error('Backup restore failed:', err.message);
    logError('Backup restore failed', err, { file, user: req.user?.username || '' });
    res.status(500).json({ error: err.message || 'Unable to restore backup.' });
  }
});

module.exports = router;
