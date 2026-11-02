const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
const {createStagedRestoreJobs}=require('../services/stagedRestoreJobs');
async function setup(t,run){const root=await fs.mkdtemp(path.join(os.tmpdir(),'restore-jobs-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));const configPath=path.join(root,'private.json');await fs.writeFile(configPath,JSON.stringify({shopId:'HFM001',database:'badizo_recovery_validation'}));return createStagedRestoreJobs({directory:path.join(root,'jobs'),shopId:'HFM001',configPath,run});}
async function terminal(jobs,id){for(let i=0;i<100;i++){const job=await jobs.read(id);if(job.state!=='running')return job;await new Promise(resolve=>setTimeout(resolve,10));}throw Error('Job did not complete');}
test('job persists verified result and refuses concurrent restore',async t=>{
  let finish;const jobs=await setup(t,()=>new Promise(resolve=>{finish=resolve;}));const initial=await jobs.start('owner');await assert.rejects(jobs.start('owner'));
  finish({shopId:'HFM001',database:'badizo_recovery_validation',stagedRestoreVerified:true,activated:false,tableCount:50,products:100,invoices:20});
  const result=await terminal(jobs,initial.id);assert.equal(result.state,'verified');assert.equal(result.activated,false);assert.equal((await jobs.status()).job.id,initial.id);
});
test('failure preserves lock and hides worker error details',async t=>{
  const jobs=await setup(t,async()=>{throw Error('secret password SQL');});const initial=await jobs.start('owner');const result=await terminal(jobs,initial.id);
  assert.equal(result.state,'failed');assert.ok(!JSON.stringify(result).includes('secret'));await assert.rejects(jobs.start('owner'));
});
test('incorrect shop result cannot be advertised as restored',async t=>{
  const jobs=await setup(t,async()=>({shopId:'HFM002',activated:false,stagedRestoreVerified:true}));const initial=await jobs.start('owner');assert.equal((await terminal(jobs,initial.id)).state,'failed');
});
