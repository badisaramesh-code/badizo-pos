'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {fork} = require('node:child_process');
const {once} = require('node:events');
const {acquireWorkerLock} = require('./native-worker-lock.cjs');

if (process.send) {
  acquireWorkerLock(__dirname).then(() => process.send('locked'));
} else {
  test('only one worker runs and a forced exit releases ownership', {timeout:10000}, async () => {
    const child = fork(__filename, [], {stdio:['ignore','ignore','inherit','ipc']});
    try {
      await once(child, 'message');
      await assert.rejects(acquireWorkerLock(__dirname), {code:'EADDRINUSE'});
      const stopped = once(child, 'exit');
      child.kill('SIGKILL');
      await stopped;
      const release = await acquireWorkerLock(__dirname);
      await release();
    } finally { child.kill(); }
  });
}
