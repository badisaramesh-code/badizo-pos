const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto'),http=require('node:http'),express=require('express');
const {atomic}=require('../services/recoveryControlFiles');
const {installRecoveryRouteCompletion}=require('../services/recoveryRouteCompletion');
const {protectAsyncRoutes}=require('../middleware/asyncRoutes');
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function fixture(t){
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'badizo-http-acceptance-'));
  const file=path.join(directory,'binding.json');
  const binding={schemaVersion:1,shopId:'HFM001',activationId:crypto.randomUUID(),generation:1,phase:'active',billingMode:'active',database:{host:'127.0.0.1',user:'isolated',password:'isolated',database:'badizo_recovery_httpacceptance'}};
  await atomic(file,binding);
  const keys=['BADIZO_RUNTIME_BINDING','BADIZO_SHOP_ID','BADIZO_SYNC_ENROLLMENT_CONFIG'],previous=Object.fromEntries(keys.map(key=>[key,process.env[key]]));
  process.env.BADIZO_RUNTIME_BINDING=file;process.env.BADIZO_SHOP_ID='HFM001';process.env.BADIZO_SYNC_ENROLLMENT_CONFIG=path.join(directory,'enrollment.json');
  delete require.cache[require.resolve('../services/recoveryRuntimeBinding')];
  const runtime=require('../services/recoveryRuntimeBinding');runtime.load();
  const app=express();app.use('/api',runtime.middleware);
  const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
  t.after(async()=>{
    server.closeAllConnections();await new Promise(resolve=>server.close(resolve));
    for(const key of keys)if(previous[key]===undefined)delete process.env[key];else process.env[key]=previous[key];
    const target=path.resolve(directory),tempRoot=path.resolve(os.tmpdir())+path.sep;
    assert.ok(target.startsWith(tempRoot)&&path.basename(target).startsWith('badizo-http-acceptance-'));
    await fs.rm(target,{recursive:true,force:true});
  });
  return {app,runtime,url:'http://127.0.0.1:'+server.address().port,file,binding};
}
test('real HTTP write drain blocks new billing while an admitted operation finishes',async t=>{
  const f=await fixture(t);let release,admitted,completed=0;
  const entered=new Promise(resolve=>{admitted=resolve;}),finish=new Promise(resolve=>{release=resolve;});
  f.app.post('/api/billing/checkout',async(req,res)=>{admitted();await finish;completed++;res.json({saved:true});});
  const first=fetch(f.url+'/api/billing/checkout',{method:'POST'});await entered;
  assert.equal(f.runtime.status().activeWrites,1);
  await atomic(f.file,{...f.binding,phase:'validating',billingMode:'standby'});
  assert.equal((await fetch(f.url+'/api/billing/checkout',{method:'POST'})).status,409);
  assert.equal(f.runtime.status().activeWrites,1);assert.equal(completed,0);
  release();assert.equal((await first).status,200);assert.equal(completed,1);
  await sleep(5);assert.equal(f.runtime.status().activeWrites,0);
  await atomic(f.file,{...f.binding,billingMode:'standby'});
  assert.equal((await fetch(f.url+'/api/billing/checkout',{method:'POST'})).status,409);
});
test('an aborted response retains the write lease until handler completion, then permits recovery',async t=>{
  const f=await fixture(t);let release,admitted,completed=0;
  const entered=new Promise(resolve=>{admitted=resolve;}),finish=new Promise(resolve=>{release=resolve;});
  const routeContainer=express.Router();
  routeContainer.post('/api/billing/checkout',async(req,res)=>{
    admitted();await finish;completed++;res.json({saved:true});
  });
  f.app.use(routeContainer);
  assert.equal(installRecoveryRouteCompletion(routeContainer),1);assert.equal(installRecoveryRouteCompletion(routeContainer),0);
  // Match production registration: completion observes async handlers first,
  // then general Express rejection protection wraps the registered routes.
  protectAsyncRoutes(routeContainer._router || routeContainer);
  const outgoing=http.request(f.url+'/api/billing/checkout',{method:'POST'});outgoing.on('error',()=>{});outgoing.end();await entered;
  outgoing.destroy();await sleep(20);
  assert.equal(f.runtime.status().activeWrites,1,'A closed socket is not proof that the transaction finished.');
  await atomic(f.file,{...f.binding,phase:'validating'});
  assert.equal((await fetch(f.url+'/api/billing/checkout',{method:'POST'})).status,409);
  release();await sleep(30);assert.equal(completed,1);
  assert.equal(f.runtime.status().activeWrites,0,'Handler completion must release an aborted request lease so recovery does not remain blocked permanently.');
});
test('terminal handler wrapper does not release early when async auth middleware calls next',async t=>{
  const f=await fixture(t);let release,admitted;
  const entered=new Promise(resolve=>{admitted=resolve;}),finish=new Promise(resolve=>{release=resolve;});
  const router=express.Router();
  router.route('/save').post(async(_req,_res,next)=>{next();},async(_req,res)=>{admitted();await finish;res.json({saved:true});}).put(async(_req,res)=>res.json({saved:true}));
  f.app.use('/api/products',router);
  assert.equal(installRecoveryRouteCompletion(f.app),2,'Each HTTP method has its own terminal handler.');
  const pending=fetch(f.url+'/api/products/save',{method:'POST'});await entered;await sleep(10);
  assert.equal(f.runtime.status().activeWrites,1);release();assert.equal((await pending).status,200);await sleep(5);assert.equal(f.runtime.status().activeWrites,0);
  assert.equal((await fetch(f.url+'/api/products/save',{method:'PUT'})).status,200);
});
test('rejected terminal handler releases its lease and reaches Express error handling',async t=>{
  const f=await fixture(t);f.app.post('/api/products/save',async()=>{throw Error('isolated rejection');});
  f.app.use((error,_req,res,_next)=>res.status(503).json({error:error.message}));
  assert.equal(installRecoveryRouteCompletion(f.app),1);
  assert.equal((await fetch(f.url+'/api/products/save',{method:'POST'})).status,503);assert.equal(f.runtime.status().activeWrites,0);
});
test('an async all-method forwarding layer cannot release a later route write',async t=>{
  const f=await fixture(t);let release,admitted;
  const entered=new Promise(resolve=>{admitted=resolve;}),finish=new Promise(resolve=>{release=resolve;});
  f.app.all('/api/products/save',async(_req,_res,next)=>next());
  f.app.post('/api/products/save',async(_req,res)=>{admitted();await finish;res.json({saved:true});});
  installRecoveryRouteCompletion(f.app);
  const pending=fetch(f.url+'/api/products/save',{method:'POST'});await entered;await sleep(10);
  assert.equal(f.runtime.status().activeWrites,1);release();assert.equal((await pending).status,200);await sleep(5);assert.equal(f.runtime.status().activeWrites,0);
});
test('restored activation rejects stale-process writes even when the new binding enables local billing',async t=>{
  const f=await fixture(t);let writes=0;f.app.post('/api/billing/checkout',(_req,res)=>{writes++;res.json({saved:true});});
  await atomic(f.file,{...f.binding,activationId:crypto.randomUUID(),generation:2,billingMode:'active'});
  assert.equal((await fetch(f.url+'/api/billing/checkout',{method:'POST'})).status,409);assert.equal(writes,0);
});
