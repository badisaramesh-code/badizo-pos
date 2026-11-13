'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
function option(value) {
  value = String(value);
  if (/[\r\n\x00]/.test(value)) throw Error('Invalid MySQL option value.');
  return '"' + value.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}
function createPrivateMysqlDefaults(env = process.env) {
  if (typeof env.DB_PASSWORD !== 'string') throw Error('MySQL backup credentials are not configured.');
  const root = path.resolve(os.tmpdir()), directory = fs.mkdtempSync(path.join(root, 'badizo-dump-'));
  const file = path.join(directory, 'client.cnf');
  const cleanup = () => {
    const resolved = path.resolve(directory);
    if (!resolved.startsWith(root + path.sep) || !path.basename(resolved).startsWith('badizo-dump-')) throw Error('Refusing unsafe temporary credential cleanup.');
    fs.rmSync(resolved, { recursive: true, force: true });
  };
  try {
    if (process.platform === 'win32') {
      const who = spawnSync('whoami.exe', [], { encoding: 'utf8', windowsHide: true });
      if (who.status !== 0 || !who.stdout.trim()) throw Error('Cannot verify backup account identity.');
      const acl = spawnSync('icacls.exe', [directory, '/inheritance:r', '/grant:r', who.stdout.trim() + ':(OI)(CI)F', 'SYSTEM:(OI)(CI)F'], { windowsHide: true, stdio: 'ignore' });
      if (acl.status !== 0) throw Error('Cannot protect temporary backup credentials.');
    } else fs.chmodSync(directory, 0o700);
    const port = Number(env.DB_PORT || 3306);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw Error('Invalid backup database port.');
    fs.writeFileSync(file, '[client]\n' + [
      'host=' + option(env.DB_HOST || 'localhost'), 'port=' + port,
      'user=' + option(env.DB_USER || 'root'), 'password=' + option(env.DB_PASSWORD),
      'protocol=TCP', 'default-character-set=utf8mb4', ''
    ].join('\n'), { flag: 'wx', mode: 0o600 });
    return { file, cleanup };
  } catch (error) { cleanup(); throw error; }
}
module.exports = { option, createPrivateMysqlDefaults };
