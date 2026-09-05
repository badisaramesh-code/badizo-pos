const fs = require('fs');
const path = require('path');
const https = require('https');
const crypto = require('crypto');
const zlib = require('zlib');
const { pipeline } = require('stream/promises');
const { spawn, spawnSync } = require('child_process');

const ROOT = 'D:\\badizo-pos-main';
const BACKEND = path.join(ROOT, 'backend');
require(path.join(BACKEND, 'node_modules', 'dotenv')).config({ path: path.join(BACKEND, '.env'), override: true, quiet: true });

const LOCAL_ROOT = 'D:\\BadizoCloudBackups';
const STATUS_FILE = path.join(LOCAL_ROOT, 'backup-status.json');
const DRIVE_FOLDER_ID = String(process.env.GOOGLE_DRIVE_BACKUP_FOLDER_ID || '').trim();
const DRIVE_SYNC_FOLDER = String(process.env.GOOGLE_DRIVE_SYNC_FOLDER || '').trim();
const TOKEN_URI = 'https://oauth2.googleapis.com/token';
const OPERATION_LOCK = path.join(LOCAL_ROOT, 'backup-operation.lock');
const LOCK_STALE_MS = 2 * 60 * 60 * 1000;

function backupKeepCount() {
  const configured = Number.parseInt(process.env.GOOGLE_DRIVE_BACKUP_KEEP_COUNT, 10);
  return Number.isInteger(configured) && configured > 0 ? configured : 730;
}

function localBackupKeepCount() {
  const configured = Number.parseInt(process.env.LOCAL_BACKUP_KEEP_COUNT, 10);
  return Number.isInteger(configured) && configured >= 0 ? configured : 0;
}
function fetchWithTimeout(url, options = {}, timeoutMs = 60 * 1000) {
  return fetch(url, {
    ...options,
    signal: options.signal || AbortSignal.timeout(timeoutMs)
  });
}

function stamp() {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
}

function ensureDir(dir) { fs.mkdirSync(dir, { recursive: true }); }

function writeBackupStatus(status, kind, details = {}) {
  ensureDir(LOCAL_ROOT);
  const payload = {
    status,
    kind,
    at: new Date().toISOString(),
    ...details
  };
  const temporary = `${STATUS_FILE}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(payload, null, 2), 'utf8');
  fs.renameSync(temporary, STATUS_FILE);
}

function base64Url(input) {
  return Buffer.from(input).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

async function serviceAccountAccessToken() {
  const credentialPath = String(process.env.GOOGLE_DRIVE_SERVICE_ACCOUNT_JSON || '').trim();
  if (!credentialPath) throw new Error('GOOGLE_DRIVE_SERVICE_ACCOUNT_JSON is missing in backend\\.env');
  const credentials = JSON.parse(fs.readFileSync(path.resolve(credentialPath), 'utf8'));
  const tokenUri = credentials.token_uri || TOKEN_URI;
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT' };
  const payload = { iss: credentials.client_email, scope: 'https://www.googleapis.com/auth/drive', aud: tokenUri, exp: now + 3600, iat: now };
  const unsignedJwt = `${base64Url(JSON.stringify(header))}.${base64Url(JSON.stringify(payload))}`;
  const signature = crypto.createSign('RSA-SHA256').update(unsignedJwt).sign(credentials.private_key);
  const assertion = `${unsignedJwt}.${base64Url(signature)}`;
  const response = await fetchWithTimeout(tokenUri, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion })
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`Google service-account token request failed: HTTP ${response.status} ${text}`);
  const data = JSON.parse(text);
  if (!data.access_token) throw new Error('Google service-account response did not contain access_token');
  return data.access_token;
}

async function oauthAccessToken() {
  const clientId = String(process.env.GOOGLE_DRIVE_CLIENT_ID || '').trim();
  const clientSecret = String(process.env.GOOGLE_DRIVE_CLIENT_SECRET || '').trim();
  const refreshToken = String(process.env.GOOGLE_DRIVE_REFRESH_TOKEN || '').trim();
  if (!clientId || !clientSecret || !refreshToken) throw new Error('Google Drive OAuth credentials are missing in backend\\.env');
  const response = await fetchWithTimeout(TOKEN_URI, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, refresh_token: refreshToken, grant_type: 'refresh_token' })
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`OAuth refresh failed: HTTP ${response.status} ${text}`);
  const data = JSON.parse(text);
  if (!data.access_token) throw new Error('OAuth response did not contain access_token');
  return data.access_token;
}

async function accessToken() {
  const mode = String(process.env.GOOGLE_DRIVE_AUTH_MODE || '').trim().toLowerCase();
  if (mode === 'service_account' || mode === 'service-account') return serviceAccountAccessToken();
  return oauthAccessToken();
}

function uploadStream(uploadUrl, filePath, token, mimeType) {
  return new Promise((resolve, reject) => {
    const stat = fs.statSync(filePath);
    const url = new URL(uploadUrl);
    const req = https.request({
      method: 'PUT',
      hostname: url.hostname,
      path: `${url.pathname}${url.search}`,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': mimeType,
        'Content-Length': stat.size
      }
    }, res => {
      let body = '';
      res.on('data', c => body += c.toString());
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error(`Upload failed: HTTP ${res.statusCode} ${body}`));
        } else {
          resolve(body ? JSON.parse(body) : {});
        }
      });
    });
    req.setTimeout(15 * 60 * 1000, () => {
      req.destroy(new Error('Google Drive upload timed out'));
    });
    req.on('error', reject);
    fs.createReadStream(filePath).on('error', reject).pipe(req);
  });
}

async function upload(filePath, driveName) {
  if (DRIVE_SYNC_FOLDER) {
    ensureDir(DRIVE_SYNC_FOLDER);
    const destination = path.join(DRIVE_SYNC_FOLDER, driveName);
    fs.copyFileSync(filePath, destination);
    console.log(`Copied ${driveName} to Google Drive desktop sync folder.`);
    return { id: 'desktop-sync', name: driveName, path: destination };
  }  if (!DRIVE_FOLDER_ID) throw new Error('GOOGLE_DRIVE_BACKUP_FOLDER_ID is missing in backend\\.env');
  const token = await accessToken();
  const stat = fs.statSync(filePath);
  const lowerName = filePath.toLowerCase();
  const mimeType = lowerName.endsWith('.zip') ? 'application/zip' : lowerName.endsWith('.gz') ? 'application/gzip' : 'application/sql';
  const response = await fetchWithTimeout('https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&fields=id,name,size,createdTime,webViewLink', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json; charset=UTF-8',
      'X-Upload-Content-Type': mimeType,
      'X-Upload-Content-Length': String(stat.size)
    },
    body: JSON.stringify({
      name: driveName,
      parents: [DRIVE_FOLDER_ID],
      description: `Badizo automatic backup ${new Date().toISOString()}`
    })
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`Unable to start upload: HTTP ${response.status} ${text}`);
  const location = response.headers.get('location');
  if (!location) throw new Error('Google Drive did not return upload URL');
  return uploadStream(location, filePath, token, mimeType);
}

async function listDrive(prefix, token) {
  const q = [
    `'${DRIVE_FOLDER_ID.replace(/'/g, "\\'")}' in parents`,
    'trashed = false',
    `name contains '${prefix.replace(/'/g, "\\'")}'`
  ].join(' and ');
  const files = [];
  let pageToken = '';
  do {
    const url = new URL('https://www.googleapis.com/drive/v3/files');
    url.searchParams.set('q', q);
    url.searchParams.set('fields', 'nextPageToken,files(id,name,size,createdTime)');
    url.searchParams.set('orderBy', 'createdTime desc');
    url.searchParams.set('pageSize', '1000');
    if (pageToken) url.searchParams.set('pageToken', pageToken);
    const r = await fetchWithTimeout(url, { headers: { Authorization: `Bearer ${token}` } });
    const text = await r.text();
    if (!r.ok) throw new Error(`Drive listing failed: HTTP ${r.status} ${text}`);
    const data = JSON.parse(text);
    files.push(...(data.files || []));
    pageToken = String(data.nextPageToken || '');
  } while (pageToken);
  return files;
}

async function pruneDrive(prefix, keep) {
  if (DRIVE_SYNC_FOLDER) {
    ensureDir(DRIVE_SYNC_FOLDER);
    const files = fs.readdirSync(DRIVE_SYNC_FOLDER)
      .filter(name => name.startsWith(prefix))
      .map(name => ({ name, path: path.join(DRIVE_SYNC_FOLDER, name) }))
      .map(item => ({ ...item, mtime: fs.statSync(item.path).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);
    for (const file of files.slice(keep)) {
      fs.rmSync(file.path, { force: true });
      console.log(`Deleted old synced Drive backup: ${file.name}`);
    }
    return;
  }  const token = await accessToken();
  const files = await listDrive(prefix, token);
  for (const file of files.slice(keep)) {
    const r = await fetchWithTimeout(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(file.id)}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` }
    });
    if (!r.ok) throw new Error(`Could not delete old Drive backup ${file.name}`);
    console.log(`Deleted old Drive backup: ${file.name}`);
  }
}

function pruneLocal(dir, prefix, keep) {
  if (!fs.existsSync(dir) || keep === 0) return;
  const files = fs.readdirSync(dir)
    .filter(n => n.startsWith(prefix))
    .map(n => ({ name:n, path:path.join(dir,n), mtime:fs.statSync(path.join(dir,n)).mtimeMs }))
    .sort((a,b) => b.mtime-a.mtime);
  for (const f of files.slice(keep)) {
    fs.rmSync(f.path, { force:true });
    console.log(`Deleted old local backup: ${f.name}`);
  }
}

function validateSqlBackup(file) {
  if (!fs.existsSync(file)) throw new Error('Backup validation failed: SQL file was not created');
  const stats = fs.statSync(file);
  if (stats.size < 1024) throw new Error(`Backup validation failed: file is too small (${stats.size} bytes)`);
  const descriptor = fs.openSync(file, 'r');
  try {
    const buffer = Buffer.alloc(4096);
    const bytesRead = fs.readSync(descriptor, buffer, 0, buffer.length, 0);
    const header = buffer.subarray(0, bytesRead).toString('utf8');
    if (!header.includes('MySQL dump') && !header.includes('MariaDB dump')) {
      throw new Error('Backup validation failed: SQL dump header was not found');
    }
  } finally {
    fs.closeSync(descriptor);
  }
  return stats;
}

function validateGzipBackup(file) {
  if (!fs.existsSync(file)) throw new Error('Backup validation failed: compressed file was not created');
  const stats = fs.statSync(file);
  if (stats.size < 1024) throw new Error(`Backup validation failed: compressed file is too small (${stats.size} bytes)`);
  const descriptor = fs.openSync(file, 'r');
  try {
    const header = Buffer.alloc(2);
    if (fs.readSync(descriptor, header, 0, 2, 0) !== 2 || header[0] !== 0x1f || header[1] !== 0x8b) {
      throw new Error('Backup validation failed: gzip header was not found');
    }
  } finally {
    fs.closeSync(descriptor);
  }
  return stats;
}

async function compressSqlBackup(sqlFile) {
  validateSqlBackup(sqlFile);
  const gzipFile = `${sqlFile}.gz`;
  const temporary = `${gzipFile}.tmp`;
  try {
    await pipeline(fs.createReadStream(sqlFile), zlib.createGzip({ level: 6 }), fs.createWriteStream(temporary, { flags: 'wx' }));
    validateGzipBackup(temporary);
    fs.renameSync(temporary, gzipFile);
    fs.rmSync(sqlFile, { force: true });
    return gzipFile;
  } catch (err) {
    fs.rmSync(temporary, { force: true });
    throw err;
  }
}
function mysqldump(outFile) {
  const exe = process.env.MYSQLDUMP_PATH || 'C:\\Program Files\\MySQL\\MySQL Server 8.0\\bin\\mysqldump.exe';
  const db = process.env.DB_NAME || 'badizo_pos';
  const args = [
    `--host=${process.env.DB_HOST || 'localhost'}`,
    `--user=${process.env.DB_USER || 'root'}`,
    `--password=${process.env.DB_PASSWORD || '1234'}`,
    '--single-transaction',
    '--quick',
    '--routines',
    '--triggers',
    '--events',
    '--hex-blob',
    '--set-gtid-purged=OFF',
    '--default-character-set=utf8mb4',
    '--databases', db,
    `--result-file=${outFile}`
  ];
  try {
    const result = spawnSync(exe, args, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'], encoding: 'utf8' });
    if (result.status !== 0) {
      const detail = String(result.stderr || '').trim().slice(0, 500);
      throw new Error(`mysqldump failed with code ${result.status}${detail ? `: ${detail}` : ''}`);
    }
    validateSqlBackup(outFile);
  } catch (err) {
    fs.rmSync(outFile, { force: true });
    throw err;
  }
}

function localBackupFiles(kind) {
  const policyPrefix = `badizo_${kind}_`;
  const dir = path.join(LOCAL_ROOT, kind);
  ensureDir(dir);
  return fs.readdirSync(dir)
    .filter(name => name.startsWith(policyPrefix) && (name.endsWith('.sql.gz') || name.endsWith('.sql')))
    .map(name => ({ name, path: path.join(dir, name) }))
    .map(item => ({ ...item, mtime: fs.statSync(item.path).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
}

async function remoteBackupNames(prefix) {
  if (DRIVE_SYNC_FOLDER) {
    ensureDir(DRIVE_SYNC_FOLDER);
    return new Set(fs.readdirSync(DRIVE_SYNC_FOLDER).filter(name => name.startsWith(prefix)));
  }
  const token = await accessToken();
  return new Set((await listDrive(prefix, token)).map(file => String(file.name || '')));
}

async function syncDailyBackups(keep = backupKeepCount()) {
  const prefix = 'badizo_daily_';
  const local = localBackupFiles('daily').slice(0, keep);
  if (!local.length) throw new Error('No local daily backup is available to synchronize');

  try {
    const remoteNames = await remoteBackupNames(prefix);
    const uploaded = [];
    for (const backup of [...local].reverse()) {
      if (remoteNames.has(backup.name)) continue;
      console.log(`Uploading pending backup ${backup.name}...`);
      const result = await upload(backup.path, backup.name);
      const localSize = fs.statSync(backup.path).size;
      if (result?.size && Number(result.size) !== localSize) {
        throw new Error(`Google Drive size verification failed for `);
      }
      uploaded.push(backup.name);
      remoteNames.add(backup.name);
    }

    await pruneDrive(prefix, keep);
    pruneLocal(path.join(LOCAL_ROOT, 'daily'), prefix, localBackupKeepCount());
    const latest = local[0];
    writeBackupStatus('success', 'daily', {
      file: latest.name,
      sizeBytes: fs.statSync(latest.path).size,
      uploadedFiles: uploaded,
      message: uploaded.length
        ? 'Google Drive backup uploaded successfully.'
        : 'Google Drive backup is already synchronized.'
    });
    return { uploaded, latest: latest.name };
  } catch (err) {
    writeBackupStatus('failed', 'daily', {
      file: local[0].name,
      message: `Google Drive upload pending; automatic retry is enabled. ${String(err.message || '').slice(0, 350)}`
    });
    throw err;
  }
}

async function databaseBackup(kind, keep) {
  const prefix = `badizo_${kind}_`;
  const dir = path.join(LOCAL_ROOT, kind);
  ensureDir(dir);

  let current;
  if (kind === 'daily') {
    const todayPrefix = `${prefix}${stamp().slice(0, 10)}_`;
    const candidates = localBackupFiles(kind).filter(item => item.name.startsWith(todayPrefix));
    for (const candidate of candidates) {
      try {
        if (candidate.path.endsWith('.gz')) validateGzipBackup(candidate.path);
        else validateSqlBackup(candidate.path);
        current = candidate;
        break;
      } catch (err) {
        console.error(`Removing invalid existing backup ${candidate.name}: ${err.message}`);
        fs.rmSync(candidate.path, { force: true });
      }
    }
  }

  if (!current) {
    const name = `${prefix}${stamp()}.sql`;
    const file = path.join(dir, name);
    console.log(`Creating ${kind} database backup...`);
    mysqldump(file);
    const compressedFile = await compressSqlBackup(file);
    current = { name: path.basename(compressedFile), path: compressedFile, mtime: fs.statSync(compressedFile).mtimeMs };
  } else {
    if (!current.path.endsWith('.gz')) {
      const compressedFile = await compressSqlBackup(current.path);
      current = { name: path.basename(compressedFile), path: compressedFile, mtime: fs.statSync(compressedFile).mtimeMs };
      console.log(`Compressed existing backup: ${current.name}`);
    } else {
      console.log(`Today's local backup already exists: ${current.name}`);
    }
  }

  // Retention is enforced locally even when the internet is unavailable.
  pruneLocal(dir, prefix, localBackupKeepCount());
  if (kind === 'daily') {
    await syncDailyBackups(keep);
  } else {
    await upload(current.path, current.name);
    await pruneDrive(prefix, keep);
  }
  console.log(`${kind} backup completed.`);
}

function zipFolder(folder) {
  if (!fs.existsSync(folder)) throw new Error(`Folder not found: ${folder}`);
  const dir = path.join(LOCAL_ROOT, 'manual');
  ensureDir(dir);
  const name = `badizo_manual_${stamp()}.zip`;
  const zip = path.join(dir, name);
  const escapedFolder = folder.replace(/'/g, "''");
  const escapedZip = zip.replace(/'/g, "''");
  const command = `Compress-Archive -Path '${escapedFolder}\\*' -DestinationPath '${escapedZip}' -Force`;
  const r = spawnSync('powershell.exe', ['-NoProfile','-ExecutionPolicy','Bypass','-Command',command], {
    windowsHide:false, stdio:'inherit'
  });
  if (r.status !== 0 || !fs.existsSync(zip)) throw new Error('Folder ZIP creation failed');
  return { zip, name };
}

async function withOperationLock(operation) {
  ensureDir(LOCAL_ROOT);
  let descriptor;
  try {
    try {
      descriptor = fs.openSync(OPERATION_LOCK, 'wx');
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      const age = Date.now() - fs.statSync(OPERATION_LOCK).mtimeMs;
      if (age > LOCK_STALE_MS) {
        fs.rmSync(OPERATION_LOCK, { force: true });
        descriptor = fs.openSync(OPERATION_LOCK, 'wx');
      } else {
        console.log('Another backup operation is already running; this invocation will exit safely.');
        return { skipped: true };
      }
    }
    fs.writeFileSync(descriptor, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
    return await operation();
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    if (descriptor !== undefined) fs.rmSync(OPERATION_LOCK, { force: true });
  }
}

async function main() {
  const mode = String(process.argv[2] || '').toLowerCase();
  if (mode === 'daily') return databaseBackup('daily', backupKeepCount());
  if (mode === 'sync-pending') return syncDailyBackups(backupKeepCount());
  if (mode === 'weekly' || mode === 'monthly') {
    console.log(`${mode} backup is disabled. Daily rolling backups only.`);
    return;
  }
  if (mode === 'upload-existing') {
    const requested = path.resolve(process.argv.slice(3).join(' ').trim());
    const dailyDir = path.join(LOCAL_ROOT, 'daily');
    const relative = path.relative(dailyDir, requested);
    if (!requested || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Existing backup must be inside the daily backup folder');
    if (!fs.existsSync(requested) || !path.basename(requested).startsWith('badizo_daily_') || !requested.toLowerCase().endsWith('.sql')) throw new Error('Valid daily SQL backup file was not found');
    return syncDailyBackups(backupKeepCount());
  }
  if (mode === 'upload-folder') {
    const folder = process.argv.slice(3).join(' ').trim();
    if (!folder) throw new Error('Folder path is required');
    const {zip,name} = zipFolder(folder);
    console.log(`Uploading ${name}...`);
    await upload(zip,name);
    pruneLocal(path.dirname(zip),'badizo_manual_',2);
    console.log('Selected folder uploaded successfully.');
    return;
  }
  throw new Error('Usage: daily | sync-pending | weekly | monthly | upload-existing <file> | upload-folder <folder>');
}

const requestedMode = String(process.argv[2] || 'unknown').toLowerCase();
withOperationLock(main).catch(err => {
  try {
    if (!['sync-pending', 'upload-existing'].includes(requestedMode)) {
      writeBackupStatus('failed', requestedMode, { message: String(err.message || 'Unknown backup error').slice(0, 500) });
    }
  } catch (statusErr) {
    console.error(`ERROR writing backup status: ${statusErr.message}`);
  }
  console.error(`ERROR: ${err.message}`);
  process.exit(1);
});
