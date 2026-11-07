const fs = require('node:fs/promises');
const path = require('node:path');
function markerPath(bindingPath, binding) {
  return bindingPath + '.' + binding.activationId + '.capture-gap';
}

async function marked(file) {
  try {
    const stat = await fs.lstat(file);
    if (!stat.isFile()) throw Error('Invalid capture gap evidence.');
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

async function record(file, binding) {
  let handle;
  try {
    handle = await fs.open(file, 'wx', 0o600);
  } catch (error) {
    if (error.code === 'EEXIST' && await marked(file)) return;
    throw error;
  }
  try {
    await handle.writeFile(JSON.stringify({shopId:binding.shopId, activationId:binding.activationId, at:new Date().toISOString()}));
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function hasCaptureGap(bindingPath, binding) {
  return marked(markerPath(bindingPath, binding));
}

async function recordCaptureGap(bindingPath, binding) {
  const file = markerPath(bindingPath, binding);
  await record(file, binding);
  if (process.platform !== 'win32') {
    const directory = await fs.open(path.dirname(file), 'r');
    try { await directory.sync(); } finally { await directory.close(); }
  }
}

module.exports = {hasCaptureGap, recordCaptureGap};
