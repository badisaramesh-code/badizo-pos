const crypto = require('crypto');
const fs = require('fs');
const https = require('https');
const path = require('path');
const { URL } = require('url');
const { logError, logInfo } = require('./logger');

const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive';
const DEFAULT_TOKEN_URI = 'https://oauth2.googleapis.com/token';

function isDriveBackupEnabled() {
  return String(process.env.GOOGLE_DRIVE_BACKUP_ENABLED || '').toLowerCase() === 'true';
}

function driveKeepCount() {
  return Math.max(Number.parseInt(process.env.GOOGLE_DRIVE_BACKUP_KEEP_COUNT, 10) || 3, 1);
}

function base64Url(input) {
  return Buffer.from(input)
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

function loadServiceAccount() {
  const credentialPath = String(process.env.GOOGLE_DRIVE_SERVICE_ACCOUNT_JSON || '').trim();
  if (credentialPath) {
    return JSON.parse(fs.readFileSync(path.resolve(credentialPath), 'utf8'));
  }

  const clientEmail = String(process.env.GOOGLE_DRIVE_CLIENT_EMAIL || '').trim();
  const privateKey = String(process.env.GOOGLE_DRIVE_PRIVATE_KEY || '').replace(/\\n/g, '\n').trim();
  if (clientEmail && privateKey) {
    return {
      client_email: clientEmail,
      private_key: privateKey,
      token_uri: process.env.GOOGLE_DRIVE_TOKEN_URI || DEFAULT_TOKEN_URI
    };
  }

  throw new Error('Google Drive backup is enabled, but service account credentials are not configured.');
}

async function getOAuthAccessToken() {
  const clientId = String(process.env.GOOGLE_DRIVE_CLIENT_ID || '').trim();
  const clientSecret = String(process.env.GOOGLE_DRIVE_CLIENT_SECRET || '').trim();
  const refreshToken = String(process.env.GOOGLE_DRIVE_REFRESH_TOKEN || '').trim();
  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error('Google Drive OAuth backup requires GOOGLE_DRIVE_CLIENT_ID, GOOGLE_DRIVE_CLIENT_SECRET and GOOGLE_DRIVE_REFRESH_TOKEN.');
  }

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

  if (!response.ok) {
    throw new Error(`Google OAuth refresh failed: HTTP ${response.status} ${await response.text()}`);
  }

  const data = await response.json();
  if (!data.access_token) {
    throw new Error('Google OAuth refresh response did not include access_token.');
  }
  return data.access_token;
}

async function getServiceAccountAccessToken() {
  const credentials = loadServiceAccount();
  const tokenUri = credentials.token_uri || DEFAULT_TOKEN_URI;
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT' };
  const payload = {
    iss: credentials.client_email,
    scope: DRIVE_SCOPE,
    aud: tokenUri,
    exp: now + 3600,
    iat: now
  };
  const unsignedJwt = `${base64Url(JSON.stringify(header))}.${base64Url(JSON.stringify(payload))}`;
  const signature = crypto.createSign('RSA-SHA256').update(unsignedJwt).sign(credentials.private_key);
  const assertion = `${unsignedJwt}.${base64Url(signature)}`;

  const response = await fetch(tokenUri, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion
    })
  });

  if (!response.ok) {
    throw new Error(`Google token request failed: HTTP ${response.status} ${await response.text()}`);
  }

  const data = await response.json();
  if (!data.access_token) {
    throw new Error('Google token response did not include access_token.');
  }
  return data.access_token;
}

async function getAccessToken() {
  const mode = String(process.env.GOOGLE_DRIVE_AUTH_MODE || '').toLowerCase();
  if (mode === 'oauth' || process.env.GOOGLE_DRIVE_REFRESH_TOKEN) {
    return getOAuthAccessToken();
  }
  return getServiceAccountAccessToken();
}

async function driveFetchJson(url, token, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(options.headers || {})
    }
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Google Drive request failed: HTTP ${response.status} ${text}`);
  }
  return text ? JSON.parse(text) : {};
}

function putFileStream(uploadUrl, filePath, fileSize, mimeType, token) {
  return new Promise((resolve, reject) => {
    const url = new URL(uploadUrl);
    const request = https.request({
      method: 'PUT',
      hostname: url.hostname,
      path: `${url.pathname}${url.search}`,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': mimeType,
        'Content-Length': fileSize
      }
    }, (response) => {
      let body = '';
      response.on('data', (chunk) => {
        body += chunk.toString();
      });
      response.on('end', () => {
        if (response.statusCode < 200 || response.statusCode >= 300) {
          reject(new Error(`Google Drive upload failed: HTTP ${response.statusCode} ${body}`));
          return;
        }
        resolve(body ? JSON.parse(body) : {});
      });
    });

    request.on('error', reject);
    fs.createReadStream(filePath).on('error', reject).pipe(request);
  });
}

async function uploadBackupToDrive(backup) {
  if (!isDriveBackupEnabled()) {
    return { enabled: false };
  }

  const folderId = String(process.env.GOOGLE_DRIVE_BACKUP_FOLDER_ID || '').trim();
  if (!folderId) {
    throw new Error('GOOGLE_DRIVE_BACKUP_FOLDER_ID is required when Google Drive backup is enabled.');
  }

  const token = await getAccessToken();
  const stats = await fs.promises.stat(backup.path);
  const mimeType = 'application/sql';
  const metadata = {
    name: backup.file,
    parents: [folderId],
    description: `Badizo POS database backup created at ${new Date().toISOString()}`
  };

  const response = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&fields=id,name,size,createdTime,webViewLink', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json; charset=UTF-8',
      'X-Upload-Content-Type': mimeType,
      'X-Upload-Content-Length': String(stats.size)
    },
    body: JSON.stringify(metadata)
  });

  if (!response.ok) {
    throw new Error(`Unable to start Google Drive upload: HTTP ${response.status} ${await response.text()}`);
  }

  const uploadUrl = response.headers.get('location');
  if (!uploadUrl) {
    throw new Error('Google Drive did not return a resumable upload URL.');
  }

  const uploaded = await putFileStream(uploadUrl, backup.path, stats.size, mimeType, token);
  logInfo('Google Drive backup uploaded', {
    file: backup.file,
    driveFileId: uploaded.id,
    sizeBytes: stats.size
  });
  return { enabled: true, uploaded: true, file: uploaded };
}

async function listDriveBackups(token = null) {
  if (!isDriveBackupEnabled()) return [];
  const folderId = String(process.env.GOOGLE_DRIVE_BACKUP_FOLDER_ID || '').trim();
  if (!folderId) return [];
  const accessToken = token || await getAccessToken();
  const query = [
    `'${folderId.replace(/'/g, "\\'")}' in parents`,
    'trashed = false',
    "name contains 'badizo_pos_backup_'"
  ].join(' and ');
  const url = new URL('https://www.googleapis.com/drive/v3/files');
  url.searchParams.set('q', query);
  url.searchParams.set('fields', 'files(id,name,size,createdTime,modifiedTime,webViewLink)');
  url.searchParams.set('orderBy', 'createdTime desc');
  url.searchParams.set('pageSize', '100');
  const data = await driveFetchJson(url.toString(), accessToken);
  return data.files || [];
}

async function pruneDriveBackups(keepCount = driveKeepCount()) {
  if (!isDriveBackupEnabled()) return { enabled: false, deleted: [] };
  const token = await getAccessToken();
  const files = await listDriveBackups(token);
  const oldFiles = files.slice(keepCount);
  const deleted = [];
  for (const file of oldFiles) {
    const response = await fetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(file.id)}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` }
    });
    if (!response.ok) {
      throw new Error(`Unable to delete old Google Drive backup ${file.name}: HTTP ${response.status} ${await response.text()}`);
    }
    deleted.push(file.name);
  }
  if (deleted.length) {
    logInfo('Old Google Drive backups deleted', { keepCount, deleted });
  }
  return { enabled: true, deleted };
}

module.exports = {
  driveKeepCount,
  isDriveBackupEnabled,
  listDriveBackups,
  pruneDriveBackups,
  uploadBackupToDrive
};
