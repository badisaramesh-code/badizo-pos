const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
require('dotenv').config();

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

function getBackupPath(fileName) {
  const safeName = path.basename(fileName);
  if (!safeName.endsWith('.sql')) return null;
  return path.join(backupDir, safeName);
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
      resolve({
        file: fileName,
        path: filePath,
        sizeBytes: stats.size,
        createdAt: stats.birthtime
      });
    });
  });
}

function scheduleDailyBackup() {
  const runAt = process.env.BACKUP_DAILY_TIME || '22:30';
  const [hourText, minuteText] = runAt.split(':');
  const hour = Math.min(Math.max(Number.parseInt(hourText, 10) || 22, 0), 23);
  const minute = Math.min(Math.max(Number.parseInt(minuteText, 10) || 30, 0), 59);

  const scheduleNext = () => {
    const now = new Date();
    const next = new Date(now);
    next.setHours(hour, minute, 0, 0);
    if (next <= now) next.setDate(next.getDate() + 1);

    const delay = next.getTime() - now.getTime();
    setTimeout(async () => {
      try {
        const result = await runDatabaseBackup();
        console.log(`Daily backup created: ${result.file}`);
      } catch (err) {
        console.error('Daily backup failed:', err.message);
      } finally {
        scheduleNext();
      }
    }, delay);
  };

  scheduleNext();
  console.log(`Daily database backup scheduled at ${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}.`);
}

module.exports = {
  backupDir,
  getBackupPath,
  listBackups,
  runDatabaseBackup,
  scheduleDailyBackup
};
