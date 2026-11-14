'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { backupConfiguration } = require('../services/backupConfiguration');

async function routeHealth({ status, cloudEnabled, filesystemError = false }) {
  let handler;
  const router = { use() {}, get(_path, fn) { handler = fn; } };
  const config = backupConfiguration({}, { backup_drive_enabled: String(cloudEnabled) });
  const dependencies = {
    express: { Router: () => router }, path,
    fs: { existsSync: () => true, promises: {
      readFile: async () => JSON.stringify(status),
      readdir: async () => { if (filesystemError) throw Error('Access denied'); return ['badizo_daily_fixture.sql.gz']; },
      stat: async () => ({ mtime: new Date('2026-11-14T09:00:00') })
    } },
    '../middleware/auth': { authenticate() {} },
    '../config/db': {},
    '../services/backupConfiguration': { loadBackupConfiguration: async () => config }
  };
  const context = { module: { exports: {} }, process: { env: {} }, console,
    require(name) { if (!(name in dependencies)) throw Error('Unexpected dependency: ' + name); return dependencies[name]; } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../routes/backupHealth.js'), 'utf8'), context);
  let body;
  const response = { setHeader() {}, json(value) { body = value; }, status() { return response; } };
  await handler({}, response);
  return body;
}

async function alerts(health) {
  const source = fs.readFileSync(path.join(__dirname, '../../frontend/src/utils/backupHealth.js'), 'utf8');
  const { backupAlerts } = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
  return backupAlerts(health, new Date('2026-11-14T12:00:00'));
}

test('actual backup-health response keeps local failure visible with Drive disabled', async () => {
  const health = await routeHealth({ cloudEnabled: false, status: { status: 'failed', localStatus: 'failed', at: '2026-11-14T09:05:00', message: 'Disk full' } });
  const result = await alerts(health);
  assert.equal(result.length, 1);
  assert.equal(result[0].channel, 'local');
  assert.equal(result[0].status, 'failed');
  assert.match(result[0].message, /Disk full/);
});

test('turning Drive off hides historical upload errors but retains local success', async () => {
  const health = await routeHealth({ cloudEnabled: false, status: { status: 'cloud-failed', localStatus: 'success', localAt: '2026-11-14T09:00:00', cloudStatus: 'failed', at: '2026-11-14T09:05:00', message: 'OAuth upload error' } });
  const result = await alerts(health);
  assert.equal(health.cloudStatus, 'disabled');
  assert.equal(result.length, 1);
  assert.equal(result[0].channel, 'local');
  assert.equal(result[0].status, 'success');
  assert.doesNotMatch(result[0].message, /OAuth/);
});

test('enabled Drive upload failure is distinct from local backup success', async () => {
  const health = await routeHealth({ cloudEnabled: true, status: { status: 'cloud-failed', localStatus: 'success', localAt: '2026-11-14T09:00:00', cloudStatus: 'failed', at: '2026-11-14T09:05:00', message: 'Upload failed' } });
  const result = await alerts(health);
  assert.equal(result.length, 1);
  assert.equal(result[0].channel, 'cloud');
  assert.equal(result[0].status, 'failed');
  assert.equal(health.localStatus, 'success');
});

test('unreadable backup folder surfaces a local warning without a Drive error', async () => {
  const health = await routeHealth({ cloudEnabled: false, filesystemError: true, status: {} });
  const result = await alerts(health);
  assert.equal(result.length, 1);
  assert.equal(result[0].channel, 'local');
  assert.equal(result[0].status, 'failed');
  assert.match(result[0].message, /Access denied/);
});
