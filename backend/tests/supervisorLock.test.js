const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const {spawn} = require('node:child_process');
const {acquireSupervisorLock} = require('../services/supervisorLock');

test('only one replacement can own a crashed supervisor lock', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(),'pos-lock-'));
  t.after(() => fs.rm(directory,{recursive:true,force:true}));
  const child = spawn(process.execPath,['-e',''],{windowsHide:true});
  await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',resolve);});
  const file = path.join(directory,'supervisor.lock');
  await fs.writeFile(file,String(child.pid));
  const results = await Promise.allSettled([acquireSupervisorLock(directory),acquireSupervisorLock(directory)]);
  const acquired = results.filter(result => result.status === 'fulfilled');
  assert.equal(acquired.length,1);
  assert.equal(await fs.readFile(file,'utf8'),String(process.pid));
  await assert.rejects(acquireSupervisorLock(directory));
  await acquired[0].value();
  const release = await acquireSupervisorLock(directory);
  await release();
});
