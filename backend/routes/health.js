const express = require('express');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { readPrinterHealth } = require('../services/printerHealth');
const db = require('../config/db');
const { authenticate, authorize } = require('../middleware/auth');
const { getBackupSources, listBackups } = require('../services/backupService');
const { ERROR_LOG, SYSTEM_LOG, logError } = require('../services/logger');

const router = express.Router();

router.get('/usage-enabled', authenticate, (_req,res)=>res.json({enabled:require('../services/workspaceUsage').enabled}));
router.post('/workspace-open', authenticate, (req,res)=>{
  require('../services/workspaceUsage').record(req.body?.area).catch(()=>{});
  res.sendStatus(204);
});

router.use(authenticate, authorize('SERVER', 'ADMIN'));

function localIpAddresses() {
  return Object.values(os.networkInterfaces())
    .flat()
    .filter((item) => item && item.family === 'IPv4' && !item.internal)
    .map((item) => item.address);
}

async function diskHealth() {
  let backupDir;
  try {
    backupDir=(await getBackupSources()).find(source=>source.key==='manual').dir;
    const targetPath = path.parse(backupDir).root || backupDir;
    const stats = await fs.statfs(targetPath);
    const freeBytes = Number(stats.bavail || 0) * Number(stats.bsize || 0);
    const totalBytes = Number(stats.blocks || 0) * Number(stats.bsize || 0);
    const usedPercent = totalBytes > 0 ? Math.round(((totalBytes - freeBytes) / totalBytes) * 100) : null;
    return {
      ok: true,
      path: targetPath,
      freeBytes,
      totalBytes,
      usedPercent
    };
  } catch (err) {
    return {
      ok: false,
      path: backupDir,
      error: err.message
    };
  }
}

async function logFileHealth() {
  const files = [
    ['System log', SYSTEM_LOG],
    ['Error log', ERROR_LOG]
  ];

  const rows = [];
  for (const [label, filePath] of files) {
    try {
      const stats = await fs.stat(filePath);
      rows.push({ label, path: filePath, exists: true, sizeBytes: stats.size, modifiedAt: stats.mtime });
    } catch (err) {
      rows.push({ label, path: filePath, exists: false, sizeBytes: 0, modifiedAt: null });
    }
  }
  return rows;
}

router.get('/', async (_req, res) => {
  const startedAt = new Date();
  const port = Number(process.env.PORT || 5000);
  const health = {
    checkedAt: startedAt,
    backend: {
      ok: true,
      port,
      uptimeSeconds: Math.round(process.uptime()),
      nodeVersion: process.version,
      pid: process.pid
    },
    mysql: { ok: false },
    backup: { ok: false },
    disk: { ok: false },
    network: {
      serverIps: localIpAddresses(),
      port,
      portReachable: true
    },
    printers: { ok: false, printers: [] },
    logs: []
  };

  try {
    const [rows] = await db.query('SELECT VERSION() AS version, DATABASE() AS database_name');
    health.mysql = {
      ok: true,
      version: rows[0]?.version || '',
      database: rows[0]?.database_name || ''
    };
  } catch (err) {
    logError('MySQL health check failed', err);
    health.mysql = { ok: false, error: err.message };
  }

  let backupDir;
  try {
    backupDir=(await getBackupSources()).find(source=>source.key==='manual').dir;
    const backups = await listBackups();
    const lastBackup = backups[0] || null;
    health.backup = {
      ok: Boolean(lastBackup),
      backupDir,
      lastBackup,
      backupCount: backups.length
    };
  } catch (err) {
    logError('Backup health check failed', err);
    health.backup = { ok: false, backupDir, error: err.message };
  }

  health.disk = await diskHealth();
  health.printers = await readPrinterHealth();
  health.logs = await logFileHealth();

  res.json(health);
});

module.exports = router;
