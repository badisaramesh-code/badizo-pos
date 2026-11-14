'use strict';

const net = require('node:net');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');

// The kernel releases the listening endpoint even after forced termination.
async function acquireWorkerLock(directory) {
  const realPath = await fs.realpath(directory);
  const identity = process.platform === 'win32' ? realPath.toLowerCase() : realPath;
  const name = 'badizo-native-sync-' + crypto.createHash('sha256').update(identity).digest('hex').slice(0, 32);
  const endpoint = process.platform === 'win32' ? '\\\\.\\pipe\\' + name : '\0' + name;
  const server = net.createServer(socket => socket.destroy());
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(endpoint, () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
  return () => new Promise(resolve => server.close(resolve));
}

module.exports = { acquireWorkerLock };
