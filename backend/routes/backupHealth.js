const express = require('express');
const fs = require('fs');
const path = require('path');
const { authenticate } = require('../middleware/auth');

const router = express.Router();
const backupRoot = 'D:\\BadizoCloudBackups';
const statusFile = path.join(backupRoot, 'backup-status.json');
const dailyDir = path.join(backupRoot, 'daily');

router.use(authenticate);

router.get('/', async (_req, res) => {
  try {
    let status = null;
    if (fs.existsSync(statusFile)) {
      status = JSON.parse(await fs.promises.readFile(statusFile, 'utf8'));
    }

    const dailyFiles = fs.existsSync(dailyDir)
      ? (await fs.promises.readdir(dailyDir)).filter((name) => /^badizo_daily_.*\.sql$/i.test(name))
      : [];
    const dailyEntries = await Promise.all(dailyFiles.map(async (name) => {
      const stats = await fs.promises.stat(path.join(dailyDir, name));
      return { name, modifiedAt: stats.mtime };
    }));
    dailyEntries.sort((a, b) => new Date(b.modifiedAt) - new Date(a.modifiedAt));
    const latest = dailyEntries[0] || null;

    res.setHeader('Cache-Control', 'no-store');
    res.json({
      status: status?.status || (latest ? 'success' : 'unknown'),
      kind: status?.kind || 'daily',
      at: status?.at || null,
      file: status?.file || latest?.name || null,
      latestSuccessAt: latest?.modifiedAt || null,
      message: status?.status === 'failed' ? String(status.message || 'Backup failed.') : '',
      retainedDailyBackups: dailyFiles.length,
      keepDailyBackups: 3
    });
  } catch (_err) {
    res.status(500).json({ error: 'Unable to read backup health.' });
  }
});

module.exports = router;