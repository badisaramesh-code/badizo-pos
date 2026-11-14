'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { backupConfiguration } = require('../services/backupConfiguration');
test('backup paths follow the configured installation destination', () => {
  const root = path.resolve('isolated-backups');
  const config = backupConfiguration({ BADIZO_CLOUD_BACKUP_DIR: root, GOOGLE_DRIVE_BACKUP_ENABLED: 'true' });
  assert.equal(config.dailyDir, path.join(root, 'daily'));
  assert.equal(config.statusFile, path.join(root, 'backup-status.json'));
  assert.equal(config.cloudEnabled, true);
  assert.equal(backupConfiguration({}).cloudEnabled, false);
});
test('disabled cloud preserves a local backup and never starts a remote request', async () => {
  const source = fs.readFileSync(path.join(__dirname, '../scripts/badizo_cloud_backup.js'), 'utf8');
  const fn = source.slice(source.indexOf('async function syncDailyBackups('), source.indexOf('\nasync function databaseBackup('));
  const statuses = [];
  const context = {
    backupConfig: { cloudEnabled: false },
    localBackupFiles: () => [{ name: 'today.sql.gz', path: 'fixture' }],
    matchesBackupAuthority: () => true,
    fs: { statSync: () => ({ size: 123 }) },
    writeBackupStatus: (...args) => statuses.push(args),
    remoteBackupNames: () => { throw Error('Remote request forbidden'); }
  };
  vm.createContext(context);
  vm.runInContext(fn + '\nthis.sync = syncDailyBackups;', context);
  const result = await context.sync(3, { assertUnchanged() {} });
  assert.equal(result.latest, 'today.sql.gz');
  assert.equal(statuses[0][0], 'local-only');
  assert.equal(statuses[0][2].sizeBytes, 123);
  context.backupConfig.cloudEnabled = true;
  await assert.rejects(context.sync(3, { assertUnchanged() {} }), /Remote request forbidden/);
  assert.equal(statuses[1][0], 'failed');
});
test('catch-up still starts local backup when cloud is disabled, but skips repeated upload attempts', () => {
  const source = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
  const fn = source.slice(source.indexOf('function checkDailyBackupCatchUp('), source.indexOf('\nfunction scheduleDailyBackupCatchUpCheck('));
  let local = false;
  const started = [];
  const context = {
    Date: class extends Date { getHours() { return 12; } },
    dailyCatchUpRunning: false,
    backupConfig: { cloudEnabled: false },
    hasTodayScheduledBackup: () => local,
    hasTodaySuccessfulCloudBackup: () => { throw Error('Cloud status must not be needed'); },
    logInfo() {}, logError() {},
    process: { execPath: 'fixture-node' },
    scheduledDailyBackupScript: 'fixture-script', __dirname: 'fixture-dir',
    spawn: (_exe, args) => { started.push(args[1]); return { on() {} }; }
  };
  vm.createContext(context);
  vm.runInContext(fn + '\ncheckDailyBackupCatchUp();', context);
  assert.deepEqual(started, ['daily']);
  local = true;
  context.dailyCatchUpRunning = false;
  vm.runInContext('checkDailyBackupCatchUp();', context);
  assert.deepEqual(started, ['daily']);
});
test('local-only health retains failures and reports local retention', async () => {
  let handler;
  const router = { use() {}, get(_path, fn) { handler = fn; } };
  const dependencies = {
    express: { Router: () => router }, path,
    fs: { existsSync: () => true, promises: {
      readFile: async () => JSON.stringify({status:'failed',message:'Disk full'}),
      readdir: async () => ['badizo_daily_old.sql.gz'],
      stat: async () => ({mtime: new Date('2026-01-01T00:00:00Z')})
    } },
    '../middleware/auth': {authenticate(){}},
    '../services/backupConfiguration': {backupConfiguration: () => ({root:'fixture',cloudEnabled:false})}
  };
  const context = {module:{exports:{}},process:{env:{LOCAL_BACKUP_KEEP_COUNT:'14'}},require(name){if(!(name in dependencies))throw Error(name);return dependencies[name];}};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../routes/backupHealth.js'),'utf8'),context);
  let output;
  await handler({}, {setHeader(){},json(value){output=value;},status(){throw Error('Health request failed');}});
  assert.equal(output.status,'failed');assert.equal(output.message,'Disk full');assert.equal(output.keepDailyBackups,14);
});
test('disabled cloud rejects explicit folder uploads before packaging or contacting Drive', async () => {
  const source=fs.readFileSync(path.join(__dirname,'../scripts/badizo_cloud_backup.js'),'utf8');
  const context={backupConfig:{cloudEnabled:false},process:{argv:['node','backup','upload-folder','fixture']},zipFolder(){throw Error('Must not package folder');},upload(){throw Error('Must not contact Drive');}};
  vm.createContext(context);
  vm.runInContext(source.slice(source.indexOf('async function main()'),source.indexOf('\nconst requestedMode ='))+'\nthis.run=main;',context);
  await assert.rejects(context.run(),/Google Drive backup is disabled/);
  vm.runInContext(source.slice(source.indexOf('async function upload(filePath'),source.indexOf('\nasync function listDrive('))+'\nthis.directUpload=upload;',context);
  await assert.rejects(context.directUpload('fixture','fixture'),/Google Drive backup is disabled/);
});
