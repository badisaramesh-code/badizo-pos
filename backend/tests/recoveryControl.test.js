const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto'),express=require('express'),jwt=require('jsonwebtoken');
const {atomic}=require('../services/recoveryControlFiles');
const {createRecoveryControl}=require('../services/recoveryControl');
const {createRouter}=require('../routes/recoveryControl');
const {JWT_SECRET}=require('../middleware/auth');
test('control queue rejects stale generations and duplicate requests without exposing database credentials',async t=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'badizo-control-'));t.after(()=>fs.rm(directory,{recursive:true,force:true}));
  const bindingPath=path.join(directory,'binding.json'),configPath=path.join(directory,'config.json');
  await atomic(bindingPath,{schemaVersion:1,shopId:'HFM001',activationId:crypto.randomUUID(),generation:1,phase:'active',billingMode:'active',database:{host:'127.0.0.1',user:'private-user',password:'private-password',database:'test_database'}});
  await atomic(configPath,{shopId:'HFM001',nodeRole:'local-server',directory,bindingPath});
  await atomic(path.join(directory,'heartbeat.json'),{shopId:'HFM001',at:new Date().toISOString()});
  const control=createRecoveryControl({configPath,shopId:'HFM001'});
  await assert.rejects(control.request({kind:'standby',expectedGeneration:0,actor:'owner'}));
  await control.request({kind:'standby',expectedGeneration:1,actor:'owner'});
  const status=await control.status();assert.equal(status.operation.state,'queued');assert.ok(!JSON.stringify(status).includes('private-'));
  await assert.rejects(control.request({kind:'standby',expectedGeneration:1,actor:'owner'}));
});
test('recovery API requires owner confirmation and does not accept commands or forged actors',async t=>{
  const calls=[];const app=express();app.use(express.json());app.use('/control',createRouter({request:async value=>{calls.push(value);return {state:'queued'};},status:async()=>({configured:true})}));
  const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
  const post=(role,body)=>fetch('http://127.0.0.1:'+server.address().port+'/control',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+jwt.sign({role,username:'actual-owner'},JWT_SECRET)},body:JSON.stringify(body)});
  const body={kind:'standby',expectedGeneration:1,confirmation:'PAUSE BILLING'};
  assert.equal((await post('ADMIN',body)).status,403);assert.equal((await post('SERVER',{...body,actor:'forged'})).status,400);assert.equal((await post('SERVER',{...body,command:'delete'})).status,400);assert.equal((await post('SERVER',body)).status,202);
  assert.equal(calls.length,1);assert.equal(calls[0].actor,'actual-owner');
});
