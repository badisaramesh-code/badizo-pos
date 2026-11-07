const fs = require('node:fs/promises');
const path = require('node:path');
const net = require('node:net');
const crypto = require('node:crypto');

async function deadOwner(file) {
  const pid = Number(await fs.readFile(file, 'utf8'));
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); }
  catch (error) { return error.code === 'ESRCH'; }
  return false;
}

// Serialize stale-file removal. The OS releases this brief loopback lock if
// the recovering process dies. Normal supervisor operation uses no socket.
async function acquireSupervisorLock(directory) {
  const canonical = await fs.realpath(directory);
  const file = path.join(canonical, 'supervisor.lock');
  async function claim() {
    const handle = await fs.open(file, 'wx', 0o600);
    try { await handle.writeFile(String(process.pid)); await handle.sync(); }
    catch (error) { await handle.close(); await fs.unlink(file); throw error; }
    return async () => { await handle.close(); await fs.unlink(file); };
  }
  try { return await claim(); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  if (!await deadOwner(file)) throw Error('Supervisor lock still has a live or unverifiable owner.');

  const key = process.platform === 'win32' ? canonical.toLowerCase() : canonical;
  const port = 49152 + crypto.createHash('sha256').update(key).digest().readUInt16BE() % 16384;
  const guard = net.createServer(socket => socket.destroy());
  await new Promise((resolve, reject) => {
    guard.once('error', reject);
    guard.listen({host:'127.0.0.1', port, exclusive:true}, resolve);
  });
  try {
    if (!await deadOwner(file)) throw Error('Another supervisor acquired the lock.');
    await fs.unlink(file);
    return await claim();
  } finally { await new Promise(resolve => guard.close(resolve)); }
}
module.exports = { acquireSupervisorLock };
