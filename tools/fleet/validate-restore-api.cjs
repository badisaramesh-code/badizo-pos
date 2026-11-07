// Explicit integration drill: uses an installer-provisioned EMPTY recovery DB.
// Run only on an isolated validation host. Never provides an activation path.
const crypto=require('node:crypto');
process.env.JWT_SECRET=crypto.randomBytes(48).toString('hex');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const express=require('express');
const jwt=require('jsonwebtoken');
const {createStagedRestoreJobs}=require('../../backend/services/stagedRestoreJobs');
const {createRouter}=require('../../backend/routes/stagedRestore');
async function main(){
  const [configPath,directory,scriptPath]=process.argv.slice(2);
  if(![configPath,directory,scriptPath].every(value=>value && path.isAbsolute(value)))throw Error('Provide absolute config, job directory and restore script paths.');
  const config=JSON.parse(await fs.readFile(configPath,'utf8'));
  const options={configPath,directory,scriptPath,shopId:config.shopId,python:'python3'};
  const jobs=createStagedRestoreJobs(options),app=express();app.use(express.json({limit:'16kb'}));app.use('/restore',createRouter(jobs));
  const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
  try{
    const base=`http://127.0.0.1:${server.address().port}/restore`;
    const request=(role,method='GET',body)=>fetch(base,{method,headers:{'Content-Type':'application/json',...(role?{Authorization:`Bearer ${jwt.sign({role,username:'restore-validation-owner'},process.env.JWT_SECRET,{expiresIn:'30m'})}`}:{})},...(body?{body:JSON.stringify(body)}:{})});
    assert.equal((await request(null)).status,401);
    assert.equal((await request('COUNTER')).status,403);
    assert.equal((await request('ADMIN')).status,403);
    assert.equal((await request('SERVER','POST',{confirmation:'RESTORE TO SEPARATE DATABASE',configPath:'attacker-input'})).status,400);
    const started=await request('SERVER','POST',{confirmation:'RESTORE TO SEPARATE DATABASE'});
    assert.equal(started.status,202);const first=await started.json();
    assert.equal((await request('SERVER','POST',{confirmation:'RESTORE TO SEPARATE DATABASE'})).status,409);
    let state;
    for(let n=0;n<360;n++){
      state=(await (await request('SERVER')).json()).job;
      if(state?.state!=='running')break;
      await new Promise(resolve=>setTimeout(resolve,5000));
    }
    assert.equal(state?.state,'verified');assert.equal(state.activated,false);assert.equal(state.result.activated,false);
    assert.equal((await createStagedRestoreJobs(options).read(first.id)).state,'verified');
    console.log(JSON.stringify({ownerApi:true,unauthorizedDenied:true,arbitraryConfigDenied:true,concurrentRestoreDenied:true,persistedAfterReopen:true,...state.result}));
  }finally{await new Promise(resolve=>server.close(resolve));}
}
main().catch(()=>{console.error('Restore API drill failed; inspect the persisted job. No activation was requested.');process.exitCode=1;});
