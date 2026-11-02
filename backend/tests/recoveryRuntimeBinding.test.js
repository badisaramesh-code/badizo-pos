const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto'),{EventEmitter}=require('node:events');
const runtime=require('../services/recoveryRuntimeBinding');
const {atomic}=require('../services/recoveryControlFiles');
test('runtime gate drains writes, rejects a new database before restart, and counts recovery work while standby',async t=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'badizo-runtime-'));
  const keys=['BADIZO_RUNTIME_BINDING','BADIZO_SHOP_ID','DB_HOST','DB_USER','DB_PASSWORD','DB_NAME','BADIZO_DB_BOOTSTRAP'];const previous=Object.fromEntries(keys.map(key=>[key,process.env[key]]));
  t.after(async()=>{for(const key of keys){if(previous[key]===undefined)delete process.env[key];else process.env[key]=previous[key];}await fs.rm(directory,{recursive:true,force:true});});
  const binding={schemaVersion:1,shopId:'HFM001',activationId:crypto.randomUUID(),generation:0,phase:'active',billingMode:'active',database:{host:'127.0.0.1',user:'test',password:'test',database:'test_database'}};
  const file=path.join(directory,'binding.json');await atomic(file,binding);process.env.BADIZO_RUNTIME_BINDING=file;process.env.BADIZO_SHOP_ID='HFM001';runtime.load();
  function request(route='/billing/checkout'){
    const result=new EventEmitter();result.status=code=>{result.code=code;return result;};result.json=value=>{result.body=value;return result;};
    runtime.middleware({method:'POST',path:route},result,()=>{result.allowed=true;});return result;
  }
  const sale=request();assert.equal(sale.allowed,true);assert.equal(runtime.status().activeWrites,1);
  await atomic(file,{...binding,phase:'validating'});assert.equal(request().code,409);sale.emit('finish');assert.equal(runtime.status().activeWrites,0);
  await atomic(file,{...binding,billingMode:'standby'});assert.equal(request().code,409);const review=request('/recovery-review/abc/apply');assert.equal(review.allowed,true);assert.equal(runtime.status().activeWrites,1);review.emit('finish');
  await atomic(file,{...binding,activationId:crypto.randomUUID()});assert.equal(request().code,409);
});
