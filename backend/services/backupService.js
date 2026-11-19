const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const { createGunzip } = require('zlib');
const { pipeline } = require('stream');
require('dotenv').config();
const db = require('../config/db');
const { logError, logInfo } = require('./logger');
const {
  driveKeepCount,
  isDriveBackupEnabled,
  listDriveBackups,
  pruneDriveBackups,
  uploadBackupToDrive
} = require('./googleDriveBackupService');

const {backupConfiguration,loadBackupConfiguration}=require('./backupConfiguration');
async function getBackupSources(config) {
  config=config||await loadBackupConfiguration(db);
  const legacy=backupConfiguration();
  return [{key:'manual',dir:config.manualDir,label:'Manual / System'},
    {key:'scheduled',dir:config.dailyDir,label:'Scheduled'},
    {key:'legacy-manual',dir:legacy.manualDir,label:'Previous manual folder'},
    {key:'legacy-scheduled',dir:process.env.BADIZO_SCHEDULED_BACKUP_DIR||legacy.dailyDir,label:'Previous scheduled folder'}]
    .filter((source,index,all)=>all.findIndex(item=>path.resolve(item.dir).toLowerCase()===path.resolve(source.dir).toLowerCase())===index);
}

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

function escapeMysqlOptionValue(value) {
  return String(value ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/\r?\n/g, '')
    .replace(/"/g, '\\"');
}

function restrictWindowsFileAccess(filePath) {
  if (process.platform !== 'win32') return Promise.resolve();

  // Use well-known SIDs so this also works under LocalSystem and on Windows
  // installations where the built-in group names are localized. USERNAME is
  // the machine account (for example DESKTOP-ABC$) for an NSSM LocalSystem
  // service and cannot be resolved reliably by icacls.
  const grants = ['*S-1-5-18:F', '*S-1-5-32-544:F', '*S-1-5-32-545:R'];
  const username = String(process.env.USERNAME || '').trim();
  if (username && !username.endsWith('$') && username.toUpperCase() !== 'SYSTEM') {
    grants.unshift(`${username}:R`);
  }

  return new Promise((resolve, reject) => {
    const acl = spawn('icacls.exe', [
      filePath,
      '/inheritance:r',
      '/grant:r',
      ...grants
    ], {
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'pipe']
    });

    let errorOutput = '';
    acl.stderr.on('data', (chunk) => { errorOutput += chunk.toString(); });
    acl.on('error', reject);
    acl.on('close', (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(errorOutput.trim() || `icacls failed with exit code ${code}`));
    });
  });
}

async function createMysqlDefaultsFile() {
  const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'badizo-mysql-'));
  const defaultsFile = path.join(tempDir, 'client.cnf');
  const content = [
    '[client]',
    `host="${escapeMysqlOptionValue(process.env.DB_HOST || 'localhost')}"`,
    `user="${escapeMysqlOptionValue(process.env.DB_USER || 'root')}"`,
    `password="${escapeMysqlOptionValue(process.env.DB_PASSWORD || '1234')}"`,
    'port=' + (Number.parseInt(process.env.DB_PORT, 10) || 3306),
    'default-character-set=utf8mb4',
    ''
  ].join('\r\n');

  try {
    await fs.promises.writeFile(defaultsFile, content, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    await restrictWindowsFileAccess(defaultsFile);
  } catch (err) {
    await fs.promises.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    throw new Error(`Unable to create secure temporary MySQL credentials file. ${err.message}`);
  }

  let cleaned = false;
  return {
    defaultsFile,
    async cleanup() {
      if (cleaned) return;
      cleaned = true;
      await fs.promises.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
  };
}

async function ensureBackupDir(config) {
  config=config||await loadBackupConfiguration(db);
  await fs.promises.mkdir(config.manualDir, { recursive: true });
}

async function listBackupsInDirectory(source) {
  if (!fs.existsSync(source.dir)) return [];
  const files = await fs.promises.readdir(source.dir);
  const backups = await Promise.all(
    files
      .filter((file) => file.endsWith('.sql') || file.endsWith('.sql.gz'))
      .map(async (file) => {
        const filePath = path.join(source.dir, file);
        const stats = await fs.promises.stat(filePath);
        return {
          file,
          fileKey: `${source.key}::${file}`,
          source: source.key,
          sourceLabel: source.label,
          directory: source.dir,
          sizeBytes: stats.size,
          createdAt: stats.birthtime,
          modifiedAt: stats.mtime
        };
      })
  );

  return backups;
}

async function listBackups() {
  await ensureBackupDir();
  const backups = (await Promise.all((await getBackupSources()).map(listBackupsInDirectory))).flat();
  return backups.sort((a, b) => new Date(b.modifiedAt) - new Date(a.modifiedAt));
}

async function pruneLocalBackups(keepCount,config) {
  config=config||await loadBackupConfiguration(db);
  keepCount=keepCount??config.localKeepCount;
  if(!keepCount || process.env.BADIZO_RUNTIME_BINDING)return [];
  const backupSources=await getBackupSources(config);
  const backups = (await listBackupsInDirectory(backupSources.find((source) => source.key === 'manual')))
    .sort((a, b) => new Date(b.modifiedAt) - new Date(a.modifiedAt));
  let oldBackups = backups.slice(keepCount);
  if(config.cloudEnabled){const remote=await listDriveBackups(null,config);oldBackups=oldBackups.filter(local=>remote.some(file=>file.name===local.file&&Number(file.size)===local.sizeBytes));}
  const deleted = [];
  for (const backup of oldBackups) {
    await fs.promises.rm(await getBackupPath(backup.file,config), { force: true });
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

async function getBackupPath(fileNameOrKey,config) {
  const backupSources=await getBackupSources(config);
  const value = String(fileNameOrKey || '');
  const separatorIndex = value.indexOf('::');
  const sourceKey = separatorIndex > 0 ? value.slice(0, separatorIndex) : 'manual';
  const fileName = separatorIndex > 0 ? value.slice(separatorIndex + 2) : value;
  const source = backupSources.find((item) => item.key === sourceKey);
  if (!source) return null;
  const safeName = path.basename(fileName);
  if (safeName !== fileName) return null;
  if (!safeName.endsWith('.sql') && !safeName.endsWith('.sql.gz')) return null;
  return path.join(source.dir, safeName);
}

async function restoreDatabaseBackup(fileName) {
  await ensureBackupDir();
  const filePath = await getBackupPath(fileName);
  if (!filePath || !fs.existsSync(filePath)) {
    throw new Error('Backup file not found.');
  }

  const mysqlCommand = process.env.MYSQL_PATH || 'mysql';
  const defaults = await createMysqlDefaultsFile();
  const args = [
    `--defaults-extra-file=${defaults.defaultsFile}`
  ];

  return new Promise((resolve, reject) => {
    const input = fs.createReadStream(filePath);
    const restore = spawn(mysqlCommand, args, {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe']
    });

    let errorOutput = '';
    let inputError = null;
    const streams = filePath.endsWith('.sql.gz')
      ? [input, createGunzip(), restore.stdin]
      : [input, restore.stdin];
    const inputFinished = new Promise((done) => {
      pipeline(...streams, (err) => {
        inputError = err;
        if (err) restore.kill();
        done();
      });
    });
    restore.stderr.on('data', (chunk) => {
      errorOutput += chunk.toString();
    });

    restore.on('error', async (err) => {
      await defaults.cleanup();
      reject(new Error(`Unable to start mysql restore. Install MySQL client tools or set MYSQL_PATH. ${err.message}`));
    });

    restore.on('close', async (code) => {
      await inputFinished;
      await defaults.cleanup();
      if (inputError) {
        reject(new Error(errorOutput.trim() || `Unable to read backup for restore. ${inputError.message}`));
        return;
      }
      if (code !== 0) {
        reject(new Error(errorOutput.trim() || `mysql restore failed with exit code ${code}`));
        return;
      }

      resolve({ file: path.basename(filePath), restoredAt: new Date() });
    });
  });
}

async function runDatabaseBackup() {
  const config=await loadBackupConfiguration(db);
  await ensureBackupDir(config);

  const dbName = process.env.DB_NAME || 'badizo_pos';
  const fileName = `badizo_pos_backup_${timestampForFile()}.sql`;
  const filePath = path.join(config.manualDir, fileName);
  const dumpCommand = process.env.MYSQLDUMP_PATH || 'mysqldump';
  const defaults = await createMysqlDefaultsFile();
  const args = [
    `--defaults-extra-file=${defaults.defaultsFile}`,
    '--single-transaction',
    '--no-tablespaces',
    '--quick',
    '--routines',
    '--triggers',
    '--events',
    '--hex-blob',
    '--set-gtid-purged=OFF',
    '--default-character-set=utf8mb4',
    '--column-statistics=0',
    '--databases',
    dbName
  ];

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
      await defaults.cleanup();
      reject(new Error(`Unable to start mysqldump. Install MySQL client tools or set MYSQLDUMP_PATH. ${err.message}`));
    });

    dump.on('close', async (code) => {
      output.end();
      await defaults.cleanup();
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

      backup.cloudBackup={enabled:false};
      if(config.cloudEnabled){
        try{
          backup.cloudBackup=await uploadBackupToDrive(backup,config);
          backup.deletedDriveBackups=(await pruneDriveBackups(config.driveKeepCount,config)).deleted;
        }catch(err){backup.cloudBackup={enabled:true,uploaded:false,error:err.message};logError('Google Drive backup upload failed',err,{file:backup.file});}
      }
      try{
        if(!config.cloudEnabled||backup.cloudBackup.uploaded){
          backup.deletedLocalBackups=await pruneLocalBackups(config.localKeepCount,config);
          if(config.cloudEnabled&&!config.keepLocal&&!process.env.BADIZO_RUNTIME_BINDING&&Number(backup.cloudBackup?.file?.size)===backup.sizeBytes){await fs.promises.rm(filePath,{force:true});backup.localCopyRetained=false;}
        }
      }catch(err){backup.localError='Local backup retention failed: '+err.message;logError('Local backup retention failed',err,{file:backup.file});}

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

let cloudSyncRunning = false;

async function syncPendingBackupsToDrive() {
  let config;
  try{config=await loadBackupConfiguration(db);}catch(error){logError('Backup configuration unavailable',error);return {configurationError:error.message,skipped:true};}
  if (!config.cloudEnabled || cloudSyncRunning) return { enabled: config.cloudEnabled, skipped: true };

  cloudSyncRunning = true;
  try {
    const backupSources=await getBackupSources(config);
    const manualSource = backupSources.find((source) => source.key === 'manual');
    const [localRows, driveBackups] = await Promise.all([listBackupsInDirectory(manualSource), listDriveBackups(null,config)]);
    const localBackups = localRows.sort((a, b) => new Date(b.modifiedAt) - new Date(a.modifiedAt));
    const uploadedNames = new Set(driveBackups.map((backup) => String(backup.name || '')));
    const pending = localBackups
      .filter((backup) => !uploadedNames.has(backup.file))
      .reverse();
    const uploaded = [];

    for (const backup of pending) {
      const filePath=await getBackupPath(backup.file,config);
      const result=await uploadBackupToDrive({ ...backup, path:filePath },config);
      if(!config.keepLocal&&!process.env.BADIZO_RUNTIME_BINDING&&Number(result?.file?.size)===backup.sizeBytes)await fs.promises.rm(filePath,{force:true});
      uploaded.push(backup.file);
    }

    if (uploaded.length) {
      await pruneDriveBackups(config.driveKeepCount,config);
      await pruneLocalBackups(config.localKeepCount,config);
      logInfo('Pending Google Drive backups synchronized', { uploaded });
    }
    return { enabled: true, uploaded };
  } catch (err) {
    // Internet can be unavailable for long periods. The POS remains fully local;
    // this background sync simply tries again after the configured interval.
    logError('Pending Google Drive backup sync deferred', err);
    return { enabled: true, uploaded: [], deferred: true, error: err.message };
  } finally {
    cloudSyncRunning = false;
  }
}

function scheduleCloudBackupSync() {

  const intervalMinutes = Math.max(Number.parseInt(process.env.GOOGLE_DRIVE_RETRY_MINUTES, 10) || 10, 1);
  const intervalMs = intervalMinutes * 60 * 1000;
  const timer = setInterval(() => { syncPendingBackupsToDrive(); }, intervalMs);
  setTimeout(() => { syncPendingBackupsToDrive(); }, 30 * 1000);
  timer.unref?.();
  logInfo('Google Drive backup retry scheduled', { intervalMinutes });
  return timer;
}

module.exports = {
  getBackupSources,
  getBackupPath,
  listBackups,
  pruneLocalBackups,
  runDatabaseBackup,
  restoreDatabaseBackup,
  scheduleDailyBackup,
  scheduleCloudBackupSync,
  syncPendingBackupsToDrive
};
