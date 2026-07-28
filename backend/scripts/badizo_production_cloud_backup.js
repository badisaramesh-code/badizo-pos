/**
 * Badizo Production Google Drive Backup
 *
 * Safety principles:
 * - MySQL password is never passed on the command line.
 * - A temporary MySQL option file is created with restricted permissions.
 * - Local backup is verified before upload.
 * - Old backups are deleted only after a successful Google Drive upload.
 * - Internet failure never stops Badizo POS; the next scheduled run retries.
 * - Daily, weekly and monthly backups are kept separately.
 */

'use strict';

const crypto = require('crypto');
const fs = require('fs');
const https = require('https');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { URL } = require('url');

const PROJECT_ROOT = 'D:\\badizo-pos-main';
const BACKEND_DIR = path.join(PROJECT_ROOT, 'backend');
const DOTENV_PATH = path.join(BACKEND_DIR, '.env');
const DOTENV_MODULE = path.join(BACKEND_DIR, 'node_modules', 'dotenv');

require(DOTENV_MODULE).config({ path: DOTENV_PATH });

const BACKUP_ROOT = process.env.BADIZO_CLOUD_BACKUP_DIR || 'D:\\BadizoCloudBackups';
const LOG_DIR = path.join(BACKUP_ROOT, 'logs');
const LOG_FILE = path.join(LOG_DIR, 'backup.log');
const ERROR_LOG = path.join(LOG_DIR, 'error.log');

const POLICIES = {
  daily:   { keep: 3, prefix: 'badizo_daily_' },
  weekly:  { keep: 4, prefix: 'badizo_weekly_' },
  monthly: { keep: 1, prefix: 'badizo_monthly_' }
};

const DEFAULT_TOKEN_URI = 'https://oauth2.googleapis.com/token';

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function appendLog(file, message, data = null) {
  ensureDir(path.dirname(file));
  const line = JSON.stringify({
    time: new Date().toISOString(),
    message,
    ...(data ? { data } : {})
  });
  fs.appendFileSync(file, `${line}\r\n`, 'utf8');
}

function info(message, data = null) {
  console.log(message);
  appendLog(LOG_FILE, message, data);
}

function fail(message, data = null) {
  console.error(`ERROR: ${message}`);
  appendLog(ERROR_LOG, message, data);
}

function timestamp(date = new Date()) {
  const pad = value => String(value).padStart(2, '0');
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

function requiredEnv(name) {
  const value = String(process.env[name] || '').trim();
  if (!value) throw new Error(`${name} is missing in ${DOTENV_PATH}`);
  return value;
}

function getPolicy(kind) {
  const policy = POLICIES[kind];
  if (!policy) throw new Error(`Invalid backup type: ${kind}`);
  return policy;
}

function getMysqlDumpPath() {
  const configured = String(process.env.MYSQLDUMP_PATH || '').trim();
  const fallback = 'C:\\Program Files\\MySQL\\MySQL Server 8.0\\bin\\mysqldump.exe';
  const file = configured || fallback;
  if (!fs.existsSync(file)) throw new Error(`mysqldump.exe not found: ${file}`);
  return file;
}

function escapeOptionValue(value) {
  return String(value)
    .replace(/\\/g, '\\\\')
    .replace(/\r?\n/g, '')
    .replace(/"/g, '\\"');
}

async function createTemporaryMysqlDefaults() {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'badizo-mysql-'));
  const file = path.join(dir, 'client.cnf');
  const content = [
    '[client]',
    `host="${escapeOptionValue(process.env.DB_HOST || 'localhost')}"`,
    `user="${escapeOptionValue(process.env.DB_USER || 'root')}"`,
    `password="${escapeOptionValue(requiredEnv('DB_PASSWORD'))}"`,
    'default-character-set=utf8mb4',
    ''
  ].join('\r\n');

  await fs.promises.writeFile(file, content, { encoding: 'utf8', mode: 0o600 });

  // Restrict the temporary credential file to SYSTEM and Administrators on Windows.
  if (process.platform === 'win32') {
    await runProcess('icacls.exe', [
      file,
      '/inheritance:r',
      '/grant:r',
      `${process.env.USERNAME}:R`,
      'SYSTEM:F',
      'Administrators:F'
    ], { allowFailure: true });
  }

  return {
    file,
    async cleanup() {
      await fs.promises.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  };
}

function runProcess(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      windowsHide: true,
      cwd: options.cwd || undefined,
      env: options.env || process.env,
      stdio: options.stdio || ['ignore', 'pipe', 'pipe']
    });

    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', chunk => { stdout += chunk.toString(); });
    child.stderr?.on('data', chunk => { stderr += chunk.toString(); });

    child.on('error', reject);
    child.on('close', code => {
      const result = { code, stdout, stderr };
      if (code !== 0 && !options.allowFailure) {
        reject(new Error(stderr.trim() || stdout.trim() || `${command} failed with code ${code}`));
      } else {
        resolve(result);
      }
    });
  });
}

async function createDatabaseDump(kind) {
  const policy = getPolicy(kind);
  const outputDir = path.join(BACKUP_ROOT, kind);
  ensureDir(outputDir);

  const fileName = `${policy.prefix}${timestamp()}.sql`;
  const filePath = path.join(outputDir, fileName);
  const dbName = process.env.DB_NAME || 'badizo_pos';
  const defaults = await createTemporaryMysqlDefaults();

  try {
    info(`Creating ${kind} MySQL backup: ${fileName}`);
    const args = [
      `--defaults-extra-file=${defaults.file}`, // Must be the first option.
      '--single-transaction',
      '--quick',
      '--routines',
      '--triggers',
      '--events',
      '--hex-blob',
      '--set-gtid-purged=OFF',
      '--default-character-set=utf8mb4',
      '--column-statistics=0',
      '--databases',
      dbName,
      `--result-file=${filePath}`
    ];

    await runProcess(getMysqlDumpPath(), args);

    const stat = await fs.promises.stat(filePath);
    if (stat.size < 1024) {
      throw new Error(`Backup validation failed: file is too small (${stat.size} bytes)`);
    }

    const firstBytes = await readFirstBytes(filePath, 4096);
    if (!firstBytes.includes('MySQL dump') && !firstBytes.includes('MariaDB dump')) {
      throw new Error('Backup validation failed: SQL dump header was not found');
    }

    const sha256 = await sha256File(filePath);
    const manifest = {
      format: 1,
      createdAt: new Date().toISOString(),
      type: kind,
      database: dbName,
      file: fileName,
      sizeBytes: stat.size,
      sha256
    };
    const manifestPath = `${filePath}.json`;
    await fs.promises.writeFile(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');

    return { ...manifest, path: filePath, manifestPath };
  } catch (err) {
    await fs.promises.rm(filePath, { force: true }).catch(() => {});
    await fs.promises.rm(`${filePath}.json`, { force: true }).catch(() => {});
    throw err;
  } finally {
    await defaults.cleanup();
  }
}

function readFirstBytes(file, count) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    const stream = fs.createReadStream(file, { start: 0, end: count - 1 });
    stream.on('data', chunk => {
      chunks.push(chunk);
      total += chunk.length;
    });
    stream.on('end', () => resolve(Buffer.concat(chunks, total).toString('utf8')));
    stream.on('error', reject);
  });
}

function sha256File(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    fs.createReadStream(file)
      .on('data', chunk => hash.update(chunk))
      .on('end', () => resolve(hash.digest('hex')))
      .on('error', reject);
  });
}

async function getOAuthAccessToken() {
  const clientId = requiredEnv('GOOGLE_DRIVE_CLIENT_ID');
  const clientSecret = requiredEnv('GOOGLE_DRIVE_CLIENT_SECRET');
  const refreshToken = requiredEnv('GOOGLE_DRIVE_REFRESH_TOKEN');

  const response = await fetch(DEFAULT_TOKEN_URI, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token'
    })
  });

  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Google OAuth token refresh failed: HTTP ${response.status} ${text}`);
  }

  const data = JSON.parse(text);
  if (!data.access_token) throw new Error('Google OAuth response did not include access_token');
  return data.access_token;
}

async function driveRequest(url, token, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(options.headers || {})
    }
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Google Drive API failed: HTTP ${response.status} ${text}`);
  }
  return text ? JSON.parse(text) : {};
}

function uploadStream(uploadUrl, filePath, fileSize, token) {
  return new Promise((resolve, reject) => {
    const url = new URL(uploadUrl);
    const request = https.request({
      method: 'PUT',
      hostname: url.hostname,
      path: `${url.pathname}${url.search}`,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/sql',
        'Content-Length': fileSize
      }
    }, response => {
      let body = '';
      response.on('data', chunk => { body += chunk.toString(); });
      response.on('end', () => {
        if (response.statusCode < 200 || response.statusCode >= 300) {
          reject(new Error(`Google Drive upload failed: HTTP ${response.statusCode} ${body}`));
        } else {
          resolve(body ? JSON.parse(body) : {});
        }
      });
    });

    request.setTimeout(15 * 60 * 1000, () => {
      request.destroy(new Error('Google Drive upload timed out'));
    });
    request.on('error', reject);
    fs.createReadStream(filePath).on('error', reject).pipe(request);
  });
}

async function uploadWithRetry(backup, attempts = 3) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await uploadBackup(backup);
    } catch (err) {
      lastError = err;
      fail(`Upload attempt ${attempt} failed`, { file: backup.file, error: err.message });
      if (attempt < attempts) {
        await new Promise(resolve => setTimeout(resolve, attempt * 15000));
      }
    }
  }
  throw lastError;
}

async function uploadBackup(backup) {
  const folderId = requiredEnv('GOOGLE_DRIVE_BACKUP_FOLDER_ID');
  const token = await getOAuthAccessToken();
  const metadata = {
    name: backup.file,
    parents: [folderId],
    description: JSON.stringify({
      product: 'Badizo POS',
      backupType: backup.type,
      database: backup.database,
      createdAt: backup.createdAt,
      sha256: backup.sha256
    })
  };

  const response = await fetch(
    'https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&fields=id,name,size,createdTime,webViewLink',
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json; charset=UTF-8',
        'X-Upload-Content-Type': 'application/sql',
        'X-Upload-Content-Length': String(backup.sizeBytes)
      },
      body: JSON.stringify(metadata)
    }
  );

  const responseText = await response.text();
  if (!response.ok) {
    throw new Error(`Unable to start Drive upload: HTTP ${response.status} ${responseText}`);
  }

  const location = response.headers.get('location');
  if (!location) throw new Error('Google Drive did not return a resumable upload URL');

  const uploaded = await uploadStream(location, backup.path, backup.sizeBytes, token);

  // Verify Drive reports the same size.
  const driveSize = Number(uploaded.size || 0);
  if (driveSize && driveSize !== backup.sizeBytes) {
    throw new Error(`Drive size verification failed: local=${backup.sizeBytes}, drive=${driveSize}`);
  }

  info(`Google Drive upload successful: ${backup.file}`, {
    driveFileId: uploaded.id,
    sizeBytes: backup.sizeBytes
  });
  return uploaded;
}

async function listDriveFiles(kind, token) {
  const policy = getPolicy(kind);
  const folderId = requiredEnv('GOOGLE_DRIVE_BACKUP_FOLDER_ID');
  const query = [
    `'${folderId.replace(/'/g, "\\'")}' in parents`,
    'trashed = false',
    `name contains '${policy.prefix}'`
  ].join(' and ');

  const url = new URL('https://www.googleapis.com/drive/v3/files');
  url.searchParams.set('q', query);
  url.searchParams.set('fields', 'files(id,name,size,createdTime)');
  url.searchParams.set('orderBy', 'createdTime desc');
  url.searchParams.set('pageSize', '100');

  const data = await driveRequest(url.toString(), token);
  return data.files || [];
}

async function pruneDrive(kind) {
  const policy = getPolicy(kind);
  const token = await getOAuthAccessToken();
  const files = await listDriveFiles(kind, token);
  const deleted = [];

  for (const file of files.slice(policy.keep)) {
    await driveRequest(
      `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(file.id)}`,
      token,
      { method: 'DELETE' }
    );
    deleted.push(file.name);
  }

  if (deleted.length) info(`Deleted old ${kind} Drive backups`, { deleted, keep: policy.keep });
  return deleted;
}

async function pruneLocal(kind) {
  const policy = getPolicy(kind);
  const dir = path.join(BACKUP_ROOT, kind);
  ensureDir(dir);

  const items = (await fs.promises.readdir(dir))
    .filter(name => name.startsWith(policy.prefix) && name.endsWith('.sql'))
    .map(name => ({ name, path: path.join(dir, name) }));

  const withStats = await Promise.all(items.map(async item => ({
    ...item,
    mtime: (await fs.promises.stat(item.path)).mtimeMs
  })));
  withStats.sort((a, b) => b.mtime - a.mtime);

  const deleted = [];
  for (const item of withStats.slice(policy.keep)) {
    await fs.promises.rm(item.path, { force: true });
    await fs.promises.rm(`${item.path}.json`, { force: true });
    deleted.push(item.name);
  }

  if (deleted.length) info(`Deleted old local ${kind} backups`, { deleted, keep: policy.keep });
  return deleted;
}

async function runBackup(kind) {
  const enabled = String(process.env.GOOGLE_DRIVE_BACKUP_ENABLED || '').toLowerCase() === 'true';
  if (!enabled) throw new Error('GOOGLE_DRIVE_BACKUP_ENABLED is not true in backend\\.env');

  const backup = await createDatabaseDump(kind);

  try {
    await uploadWithRetry(backup);
  } catch (err) {
    // Keep every local backup when upload fails. Never prune after failure.
    fail('Backup remains safely stored locally; Drive upload will be retried on the next run', {
      file: backup.file,
      path: backup.path,
      error: err.message
    });
    throw err;
  }

  await pruneDrive(kind);
  await pruneLocal(kind);
  info(`${kind} backup completed successfully`, {
    file: backup.file,
    sha256: backup.sha256,
    sizeBytes: backup.sizeBytes
  });
}

async function testConfiguration() {
  info('Testing MySQL and Google Drive configuration...');
  requiredEnv('DB_PASSWORD');
  requiredEnv('GOOGLE_DRIVE_CLIENT_ID');
  requiredEnv('GOOGLE_DRIVE_CLIENT_SECRET');
  requiredEnv('GOOGLE_DRIVE_REFRESH_TOKEN');
  requiredEnv('GOOGLE_DRIVE_BACKUP_FOLDER_ID');
  getMysqlDumpPath();

  const defaults = await createTemporaryMysqlDefaults();
  try {
    const mysqlPath = String(process.env.MYSQL_PATH || '').trim() ||
      'C:\\Program Files\\MySQL\\MySQL Server 8.0\\bin\\mysql.exe';
    if (!fs.existsSync(mysqlPath)) throw new Error(`mysql.exe not found: ${mysqlPath}`);
    await runProcess(mysqlPath, [
      `--defaults-extra-file=${defaults.file}`,
      '--batch',
      '--skip-column-names',
      '-e',
      'SELECT 1;'
    ]);
  } finally {
    await defaults.cleanup();
  }

  const token = await getOAuthAccessToken();
  const folderId = requiredEnv('GOOGLE_DRIVE_BACKUP_FOLDER_ID');
  await driveRequest(
    `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(folderId)}?fields=id,name,mimeType`,
    token
  );
  info('Configuration test passed: MySQL login and Google Drive folder access are working.');
}

async function main() {
  const mode = String(process.argv[2] || '').toLowerCase();
  if (mode === 'test') return testConfiguration();
  if (POLICIES[mode]) return runBackup(mode);
  throw new Error('Usage: node badizo_production_cloud_backup.js test|daily|weekly|monthly');
}

main().catch(err => {
  fail(err.message, { stack: err.stack });
  process.exit(1);
});
