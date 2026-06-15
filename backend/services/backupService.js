const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
require('dotenv').config();
const db = require('../config/db');
const { logError, logInfo } = require('./logger');
const {
  driveKeepCount,
  isDriveBackupEnabled,
  pruneDriveBackups,
  uploadBackupToDrive
} = require('./googleDriveBackupService');

const backupDir = process.env.BACKUP_DIR || path.join(__dirname, '..', 'backups');

function timestampForFile(date = new Date()) {
  const pad = (value) => String(value).padStart(2, '0');
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate())
  ].join('-') + '_' + [
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds())
  ].join('-');
}

async function ensureBackupDir() {
  await fs.promises.mkdir(backupDir, { recursive: true });
}

async function listBackups() {
  await ensureBackupDir();
  const files = await fs.promises.readdir(backupDir);
  const backups = await Promise.all(
    files
      .filter((file) => file.endsWith('.sql'))
      .map(async (file) => {
        const filePath = path.join(backupDir, file);
        const stats = await fs.promises.stat(filePath);
        return {
          file,
          sizeBytes: stats.size,
          createdAt: stats.birthtime,
          modifiedAt: stats.mtime
        };
      })
  );

  return backups.sort((a, b) => new Date(b.modifiedAt) - new Date(a.modifiedAt));
}

async function pruneLocalBackups(keepCount = driveKeepCount()) {
  const backups = await listBackups();
  const oldBackups = backups.slice(keepCount);
  const deleted = [];
  for (const backup of oldBackups) {
    await fs.promises.rm(getBackupPath(backup.file), { force: true });
    deleted.push(backup.file);
  }
  if (deleted.length) {
    logInfo('Old local backups deleted', { keepCount, deleted });
  }
  return deleted;
}

async function getDailyBackupTime() {
  try {
    const [rows] = await db.query(
      `SELECT setting_value FROM app_settings WHERE setting_key = 'backup_daily_time' LIMIT 1`
    );
    const value = String(rows[0]?.setting_value || process.env.BACKUP_DAILY_TIME || '09:00').trim();
    return /^\d{2}:\d{2}$/.test(value) ? value : '09:00';
  } catch (err) {
    logError('Backup time setting read failed', err);
    return process.env.BACKUP_DAILY_TIME || '09:00';
  }
}

function getBackupPath(fileName) {
  const safeName = path.basename(fileName);
  if (!safeName.endsWith('.sql')) return null;
  return path.join(backupDir, safeName);
}

async function restoreDatabaseBackup(fileName) {
  await ensureBackupDir();
  const filePath = getBackupPath(fileName);
  if (!filePath || !fs.existsSync(filePath)) {
    throw new Error('Backup file not found.');
  }

  const dbPassword = process.env.DB_PASSWORD === undefined ? '1234' : process.env.DB_PASSWORD;
  const mysqlCommand = process.env.MYSQL_PATH || 'mysql';
  const args = [
    `--host=${process.env.DB_HOST || 'localhost'}`,
    `--user=${process.env.DB_USER || 'root'}`
  ];

  if (dbPassword) {
    args.push(`--password=${dbPassword}`);
  }

  return new Promise((resolve, reject) => {
    const input = fs.createReadStream(filePath);
    const restore = spawn(mysqlCommand, args, {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe']
    });

    let errorOutput = '';
    input.pipe(restore.stdin);
    restore.stderr.on('data', (chunk) => {
      errorOutput += chunk.toString();
    });

    restore.on('error', (err) => {
      reject(new Error(`Unable to start mysql restore. Install MySQL client tools or set MYSQL_PATH. ${err.message}`));
    });

    restore.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(errorOutput.trim() || `mysql restore failed with exit code ${code}`));
        return;
      }

      resolve({ file: path.basename(filePath), restoredAt: new Date() });
    });
  });
}

async function runDatabaseBackup() {
  await ensureBackupDir();

  const dbName = process.env.DB_NAME || 'badizo_pos';
  const dbPassword = process.env.DB_PASSWORD === undefined ? '1234' : process.env.DB_PASSWORD;
  const fileName = `badizo_pos_backup_${timestampForFile()}.sql`;
  const filePath = path.join(backupDir, fileName);
  const dumpCommand = process.env.MYSQLDUMP_PATH || 'mysqldump';
  const args = [
    `--host=${process.env.DB_HOST || 'localhost'}`,
    `--user=${process.env.DB_USER || 'root'}`,
    '--single-transaction',
    '--routines',
    '--triggers',
    '--databases',
    dbName
  ];

  if (dbPassword) {
    args.splice(2, 0, `--password=${dbPassword}`);
  }

  return new Promise((resolve, reject) => {
    const output = fs.createWriteStream(filePath, { flags: 'wx' });
    const dump = spawn(dumpCommand, args, {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let errorOutput = '';
    dump.stdout.pipe(output);
    dump.stderr.on('data', (chunk) => {
      errorOutput += chunk.toString();
    });

    dump.on('error', async (err) => {
      output.destroy();
      await fs.promises.rm(filePath, { force: true }).catch(() => {});
      reject(new Error(`Unable to start mysqldump. Install MySQL client tools or set MYSQLDUMP_PATH. ${err.message}`));
    });

    dump.on('close', async (code) => {
      output.end();
      if (code !== 0) {
        await fs.promises.rm(filePath, { force: true }).catch(() => {});
        reject(new Error(errorOutput.trim() || `mysqldump failed with exit code ${code}`));
        return;
      }

      const stats = await fs.promises.stat(filePath);
      const backup = {
        file: fileName,
        path: filePath,
        sizeBytes: stats.size,
        createdAt: stats.birthtime
      };

      try {
        if (isDriveBackupEnabled()) {
          backup.cloudBackup = await uploadBackupToDrive(backup);
          backup.deletedDriveBackups = (await pruneDriveBackups()).deleted;
          backup.deletedLocalBackups = await pruneLocalBackups();
        } else {
          backup.cloudBackup = { enabled: false };
        }
      } catch (err) {
        backup.cloudBackup = { enabled: true, uploaded: false, error: err.message };
        logError('Google Drive backup upload failed', err, { file: backup.file, sizeBytes: backup.sizeBytes });
      }

      resolve(backup);
    });
  });
}

function scheduleDailyBackup() {
  const scheduleNext = async () => {
    const runAt = await getDailyBackupTime();
    const [hourText, minuteText] = runAt.split(':');
    const hour = Math.min(Math.max(Number.parseInt(hourText, 10) || 9, 0), 23);
    const minute = Math.min(Math.max(Number.parseInt(minuteText, 10) || 0, 0), 59);
    const now = new Date();
    const next = new Date(now);
    next.setHours(hour, minute, 0, 0);
    if (next <= now) next.setDate(next.getDate() + 1);

    const delay = next.getTime() - now.getTime();
    setTimeout(async () => {
      try {
        const result = await runDatabaseBackup();
        console.log(`Daily backup created: ${result.file}`);
        logInfo('Daily backup created', { file: result.file, sizeBytes: result.sizeBytes });
      } catch (err) {
        console.error('Daily backup failed:', err.message);
        logError('Daily backup failed', err);
      } finally {
        scheduleNext();
      }
    }, delay);

    console.log(`Daily database backup scheduled at ${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}.`);
    logInfo('Daily database backup scheduled', { time: `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}` });
  };

  scheduleNext();
}

module.exports = {
  backupDir,
  getBackupPath,
  listBackups,
  pruneLocalBackups,
  runDatabaseBackup,
  restoreDatabaseBackup,
  scheduleDailyBackup
};
