const fs = require('node:fs/promises');
const path = require('node:path');

function historyFile(directory, at) {
  return path.join(directory, 'audit-' + at.slice(0, 7) + '.jsonl');
}

async function appendSyncEvent(directory, status, time, trigger) {
  const at = new Date(time).toISOString();
  await fs.mkdir(directory, { recursive: true });
  await fs.appendFile(historyFile(directory, at), JSON.stringify({ at, status, trigger }) + '\n');
}

async function optionalRead(file) {
  try { return await fs.readFile(file, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return ''; throw error; }
}

async function history(directory, since, now, job) {
  const rows = [];
  const month = new Date(since);
  month.setUTCDate(1);
  while (month.getTime() <= now) {
    const raw = await optionalRead(historyFile(directory, month.toISOString()));
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      const row = JSON.parse(line);
      const time = Date.parse(row.at);
      if (!(time >= since && time <= now)) continue;
      rows.push({ job, at: row.at, status: row.status, trigger: row.trigger || '', file: row.file || '' });
    }
    month.setUTCMonth(month.getUTCMonth() + 1);
  }
  return rows;
}

async function backupReport(root, since, now) {
  const rows = await history(root, since, now, 'Daily backup');
  const raw = await optionalRead(path.join(root, 'backup-status.json'));
  const latest = raw ? JSON.parse(raw) : null;
  if (latest?.kind === 'daily' && Date.parse(latest.at) >= since && !rows.some(row => row.at === latest.at)) {
    rows.push({ job: 'Daily backup', at: latest.at, file: latest.file || '',
      status: latest.status === 'success' ? 'Backup job succeeded' : 'Backup job failed' });
  }
  const daily = path.join(root, 'daily');
  let names;
  try { names = await fs.readdir(daily); }
  catch (error) { if (error.code !== 'ENOENT') throw error; names = []; }
  for (const name of names.filter(name => /^badizo_daily_[\d_-]+\.sql(?:\.gz)?$/i.test(name))) {
    if (rows.some(row => row.file === name)) continue;
    const stat = await fs.stat(path.join(daily, name));
    if (stat.mtimeMs >= since) rows.push({ job: 'Daily backup', at: stat.mtime.toISOString(), file: name,
      status: 'Local file present; upload outcome unavailable' });
  }
  return rows;
}

async function readReport(settingsDirectory, now = Date.now(), backupRoot = 'D:\\BadizoCloudBackups') {
  const since = now - 30 * 86400000;
  const results = await Promise.allSettled([backupReport(backupRoot, since, now),
    history(settingsDirectory, since, now, 'Cloud database sync')]);
  const warnings = [];
  const rows = results.flatMap((result, i) => {
    if (result.status === 'fulfilled') return result.value;
    warnings.push(i === 0 ? 'Daily backup history unavailable.' : 'Cloud sync history unavailable.');
    return [];
  }).sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  return { rows, warnings };
}
module.exports = { appendSyncEvent, readReport };
