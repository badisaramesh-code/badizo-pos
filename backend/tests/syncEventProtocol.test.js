const test=require('node:test');
const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const {validateEvent,createSyncReceiver}=require('../services/syncEventProtocol');
const identity={shopId:'HFM001',peerInstallationId:'hfm-local',localInstallationId:'hfm-cloud'};
const event=()=>({eventId:crypto.randomUUID(),shopId:'HFM001',originInstallationId:'hfm-local',type:'test.sale',schemaVersion:1,payload:{amount:10,reference:'example'}});
// Transaction adapter deliberately models commit/rollback. Real MySQL crash,
// locking and network-acknowledgment tests remain required before enabling.
function fixture() {
  let committed=new Map(),business=0,working,count;
  const connection={async beginTransaction(){working=new Map(committed);count=business;},
    async execute(sql,args){
      if(sql.startsWith('INSERT')) {if(working.has(args[1])) throw Object.assign(Error('duplicate'),{code:'ER_DUP_ENTRY'});working.set(args[1],args[3]);return [{}];}
      return [[...(working.has(args[1])?[{payload_hash:working.get(args[1])}]:[])]];
    },async commit(){committed=working;business=count;},async rollback(){working=null;},release(){},
    add(){count++;}};
  return {pool:{async getConnection(){return connection;}},count:()=>business};
}
test('same committed event is acknowledged twice but applied once',async()=>{
  const f=fixture(),receive=createSyncReceiver({pool:f.pool,identity,handlers:{'test.sale':async c=>c.add()}}),e=event();
  assert.equal((await receive(e)).duplicate,false);
  assert.equal((await receive(e)).duplicate,true);assert.equal(f.count(),1);
  await assert.rejects(receive({...e,payload:{amount:20}}),/different content/);assert.equal(f.count(),1);
});
test('handler failure rolls back receipt and business work, allowing safe retry',async()=>{
  const f=fixture();let broken=true;
  const receive=createSyncReceiver({pool:f.pool,identity,handlers:{'test.sale':async c=>{c.add();if(broken)throw Error('interrupted');}}}),e=event();
  await assert.rejects(receive(e));assert.equal(f.count(),0);broken=false;
  assert.equal((await receive(e)).duplicate,false);assert.equal(f.count(),1);
});
test('wrong shop, wrong peer and unknown event contracts fail before database connection',async()=>{
  const pool={getConnection(){throw Error('must not connect');}},receive=createSyncReceiver({pool,identity,handlers:{}});
  await assert.rejects(receive({...event(),shopId:'HFM002'}),/identity mismatch/);
  await assert.rejects(receive({...event(),originInstallationId:'another-shop'}),/identity mismatch/);
  await assert.rejects(receive(event()),/Unsupported business/);
});
test('hashes are stable across JSON key order and reject invalid JSON values',()=>{
  const e=event();assert.equal(validateEvent(e,identity).hash,validateEvent({...e,payload:{reference:'example',amount:10}},identity).hash);
  assert.throws(()=>validateEvent({...e,payload:{amount:NaN}},identity));
  assert.throws(()=>validateEvent({...e,extra:'not allowed'},identity));
});
