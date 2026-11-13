const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const RETENTION_DAYS = 7;
const ownName = /^\d{13}-[0-9a-f-]{36}\.json$/;
const enabled = (env = process.env) => env.BADIZO_TRANSFER_AUDIT_ENABLED === 'true';
function historyFile(directory, at) { return path.join(directory, 'audit-' + at.slice(0, 7) + '.jsonl'); }
async function optionalRead(file) {
  try { return await fs.readFile(file, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return ''; throw error; }
}
async function ownDirectory(directory, create = false) {
  const target = path.join(directory, 'optional-transfer-history');
  if (create) await fs.mkdir(target, { recursive: true });
  try {
    const stat = await fs.lstat(target);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Invalid optional history directory');
    return target;
  } catch (error) { if (!create && error.code === 'ENOENT') return null; throw error; }
}
async function appendSyncEvent(directory, status, time, trigger, env = process.env) {
  if (!enabled(env)) return { skipped: true };
  const at = new Date(time).toISOString();
  const target = await ownDirectory(directory, true);
  // Independent exclusive files avoid racing append/compaction across processes.
  const destination = path.join(target, String(Date.parse(at)) + '-' + randomUUID() + '.json');
  const temporary = destination + '.tmp';
  const file = await fs.open(temporary, 'wx');
  try { await file.writeFile(JSON.stringify({ at, status, trigger })); await file.sync(); }
  finally { await file.close(); }
  await fs.rename(temporary, destination);
  const cutoff = Date.parse(at) - RETENTION_DAYS * 86400000;
  const names = (await fs.readdir(target)).filter(name => ownName.test(name) && Number(name.slice(0, 13)) < cutoff).slice(0, 1000);
  for (const name of names) await fs.unlink(path.join(target, name)).catch(error => { if (error.code !== 'ENOENT') throw error; });
  return { skipped: false };
}
async function history(directory, since, now, job) {
  const rows = [];
  const month = new Date(since); month.setUTCDate(1);
  while (month.getTime() <= now) {
    const raw = await optionalRead(historyFile(directory, month.toISOString()));
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      const row = JSON.parse(line); const time = Date.parse(row.at);
      if (time >= since && time <= now) rows.push({ job, at: row.at, status: row.status, trigger: row.trigger || '', file: row.file || '' });
    }
    month.setUTCMonth(month.getUTCMonth() + 1);
  }
  return rows;
}
async function syncHistory(directory, since, now) {
  const rows = await history(directory, since, now, 'Cloud database sync');
  const target = await ownDirectory(directory);
  if (target) {
    const names = (await fs.readdir(target)).filter(name => ownName.test(name) && Number(name.slice(0,13)) >= since && Number(name.slice(0,13)) <= now).sort().reverse().slice(0,1000);
    for (const name of names) {
      const raw = await optionalRead(path.join(target, name));
      if (raw) { const row = JSON.parse(raw); rows.push({ ...row, job: 'Cloud database sync' }); }
    }
  }
  return rows;
}
async function backupReport(root, since, now, includeHistory) {
  const rows = includeHistory ? await history(root, since, now, 'Daily backup') : [];
  const raw = await optionalRead(path.join(root, 'backup-status.json'));
  const latest = raw ? JSON.parse(raw) : null;
  if (latest?.kind === 'daily' && (!includeHistory || Date.parse(latest.at) >= since) && Date.parse(latest.at) <= now && !rows.some(row => row.at === latest.at)) {
    rows.push({ job: 'Daily backup', at: latest.at, file: latest.file || '', status: latest.status === 'success' ? 'Backup job succeeded' : 'Backup job failed' });
  }
  const daily = path.join(root, 'daily');
  let names;
  try { names = await fs.readdir(daily); } catch (error) { if (error.code !== 'ENOENT') throw error; names = []; }
  for (const name of names.filter(name => /^badizo_daily_[\d_-]+\.sql(?:\.gz)?$/i.test(name))) {
    if (rows.some(row => row.file === name)) continue;
    const stat = await fs.stat(path.join(daily, name));
    if (stat.mtimeMs >= since && stat.mtimeMs <= now) rows.push({ job: 'Daily backup', at: stat.mtime.toISOString(), file: name, status: 'Local file present; upload outcome unavailable' });
  }
  return includeHistory ? rows : rows.sort((a,b) => Date.parse(b.at)-Date.parse(a.at)).slice(0,1);
}
async function readReport(settingsDirectory, now = Date.now(), backupRoot = 'D:\\BadizoCloudBackups', env = process.env) {
  const historyEnabled = enabled(env); const since = now - RETENTION_DAYS * 86400000;
  const results = await Promise.allSettled([backupReport(backupRoot, since, now, historyEnabled), historyEnabled ? syncHistory(settingsDirectory, since, now) : Promise.resolve([])]);
  const warnings = [];
  const rows = results.flatMap((result, i) => {
    if (result.status === 'fulfilled') return result.value;
    warnings.push(i === 0 ? 'Daily backup status unavailable.' : 'Cloud sync history unavailable.'); return [];
  }).sort((a,b) => Date.parse(b.at)-Date.parse(a.at));
  return { rows, warnings, historyEnabled, retentionDays: RETENTION_DAYS };
}
module.exports = { appendSyncEvent, readReport };
