const express = require('express');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const db = require('../config/db');
const { authenticate, authorize } = require('../middleware/auth');
const { backupDir, listBackups } = require('../services/backupService');
const { ERROR_LOG, SYSTEM_LOG, logError } = require('../services/logger');

const router = express.Router();
const execFileAsync = promisify(execFile);

router.use(authenticate, authorize('SERVER', 'ADMIN'));

function localIpAddresses() {
  return Object.values(os.networkInterfaces())
    .flat()
    .filter((item) => item && item.family === 'IPv4' && !item.internal)
    .map((item) => item.address);
}

async function diskHealth() {
  try {
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

async function printerHealth() {
  if (process.platform !== 'win32') {
    return { ok: false, note: 'Printer health check is available on Windows only.', printers: [] };
  }

  try {
    const command = [
      'Get-Printer',
      '|',
      'Select-Object Name,DriverName,PortName,PrinterStatus,Default,Shared,ShareName',
      '|',
      'ConvertTo-Json -Depth 3'
    ].join(' ');
    const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-Command', command], {
      windowsHide: true,
      timeout: 8000
    });
    const parsed = JSON.parse(stdout || '[]');
    const printers = (Array.isArray(parsed) ? parsed : [parsed]).filter(Boolean);
    return {
      ok: printers.some((printer) => String(printer.PrinterStatus || '').toLowerCase() === 'normal'),
      printers
    };
  } catch (err) {
    logError('Printer health check failed', err);
    return { ok: false, error: err.message, printers: [] };
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

  try {
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
  health.printers = await printerHealth();
  health.logs = await logFileHealth();

  res.json(health);
});

module.exports = router;
