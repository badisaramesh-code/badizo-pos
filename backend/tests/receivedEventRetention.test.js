const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const {createSyncReceiver}=require('../services/syncEventProtocol');
test('received evidence and business work commit together; archive failure rolls both back',async()=>{
  const identity={shopId:'HFM001',localInstallationId:'cloud-test',peerInstallationId:'local-test'};
  const event={eventId:crypto.randomUUID(),shopId:identity.shopId,originInstallationId:identity.peerInstallationId,schemaVersion:1,type:'test.transaction',payload:{amount:10}};
  let saved={inbox:null,archive:null,amount:0},working,fail=true;
  const connection={beginTransaction:async()=>{working=structuredClone(saved);},execute:async(sql,args)=>{
    if(sql.startsWith('INSERT INTO sync_inbox')){if(working.inbox)throw Object.assign(Error('duplicate'),{code:'ER_DUP_ENTRY'});working.inbox=args[3];return [{}];}
    if(sql.startsWith('SELECT payload_hash FROM sync_inbox'))return [[{payload_hash:working.inbox}]];
    if(sql.startsWith('SELECT event_json,payload_hash FROM sync_outbox'))return [working.archive?[working.archive]:[]];
    if(sql.startsWith('INSERT INTO sync_outbox')){if(fail)throw Error('archive storage unavailable');assert.match(sql,/acknowledged_at/);working.archive={event_json:args[3],payload_hash:args[4]};return [{}];}
    throw Error('Unexpected SQL');
  },commit:async()=>{saved=working;},rollback:async()=>{working=null;},release:()=>{}};
  const receive=createSyncReceiver({pool:{getConnection:async()=>connection},identity,retainReceived:true,handlers:{'test.transaction':async()=>{working.amount+=10;}}});
  await assert.rejects(receive(event),/archive storage/);assert.deepEqual(saved,{inbox:null,archive:null,amount:0});
  fail=false;assert.equal((await receive(event)).duplicate,false);assert.equal(saved.amount,10);assert.deepEqual(JSON.parse(saved.archive.event_json),event);
  assert.equal((await receive(event)).duplicate,true);assert.equal(saved.amount,10);
});
