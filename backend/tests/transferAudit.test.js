const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { appendSyncEvent, readReport } = require('../services/transferAudit');

test('audit distinguishes backup files, job results and cloud retries across month boundaries', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'transfer-audit-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const dir = path.join(root, 'daily');
  const sync = path.join(root, 'sync');
  await fs.mkdir(dir);
  const at = '2026-11-01T03:30:00.000Z';
  const name = 'badizo_daily_2026-11-01_09-00-00.sql.gz';
  await fs.writeFile(path.join(root, 'backup-status.json'), JSON.stringify({ at, status: 'success', kind: 'daily', file: name }));
  await fs.writeFile(path.join(root, 'audit-2026-11.jsonl'), JSON.stringify({ at, status: 'Confirmed', file: name }) + '\n');
  const older = path.join(dir, 'badizo_daily_2026-10-31_09-00-00.sql.gz');
  await fs.writeFile(older, 'test');
  await fs.utimes(older, new Date('2026-10-31T03:30Z'), new Date('2026-10-31T03:30Z'));
  await appendSyncEvent(sync, 'Failed; retry scheduled', Date.parse('2026-10-31T21:00Z'), 'Scheduled', { BADIZO_TRANSFER_AUDIT_ENABLED: 'true' });
  await appendSyncEvent(sync, 'Completed', Date.parse('2026-11-01T21:00Z'), 'Scheduled', { BADIZO_TRANSFER_AUDIT_ENABLED: 'true' });
  const report = await readReport(sync, Date.parse('2026-11-02T00:00Z'), root, { BADIZO_TRANSFER_AUDIT_ENABLED: 'true' });
  assert.deepEqual(report.warnings, []);
  assert.deepEqual(report.rows.map(r => r.status), ['Completed','Confirmed','Failed; retry scheduled','Local file present; upload outcome unavailable']);
});

test('paused history performs no optional writes and still reports latest backup', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'transfer-paused-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const sync = path.join(root, 'missing-sync');
  assert.deepEqual(await appendSyncEvent(sync, 'Completed', Date.now(), 'Scheduled', {}), { skipped: true });
  await assert.rejects(fs.stat(sync), { code: 'ENOENT' });
  await fs.writeFile(path.join(root, 'backup-status.json'), JSON.stringify({at:'2026-10-01T00:00:00Z',kind:'daily',status:'success'}));
  const report = await readReport(sync, Date.parse('2026-11-02T00:00Z'), root, {});
  assert.equal(report.historyEnabled, false);
  assert.equal(report.retentionDays, 7);
  assert.equal(report.rows.length, 1);
  assert.equal(report.rows[0].status, 'Backup job succeeded');
});

test('enabled retention removes only expired owned optional files', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'transfer-retain-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const env = { BADIZO_TRANSFER_AUDIT_ENABLED: 'true' };
  const legacy = path.join(root, 'audit-2026-10.jsonl');
  await fs.writeFile(legacy, 'independent backup audit');
  await appendSyncEvent(root, 'Old', Date.parse('2026-10-01T00:00Z'), 'Scheduled', env);
  await appendSyncEvent(root, 'New', Date.parse('2026-11-01T00:00Z'), 'Scheduled', env);
  assert.equal((await fs.readdir(path.join(root, 'optional-transfer-history'))).length, 1);
  assert.equal(await fs.readFile(legacy, 'utf8'), 'independent backup audit');
});
