const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const {createOutboxSender}=require('../services/syncOutbox');
const {validateEvent}=require('../services/syncEventProtocol');
const identity={shopId:'QA001',localInstallationId:'qa-local',peerInstallationId:'qa-cloud'};

test('daily backlog drains in bounded batches after lost acknowledgments without losing pending events',async()=>{
  const rows=Array.from({length:2160},(_,index)=>{
    const event={eventId:crypto.randomUUID(),shopId:identity.shopId,originInstallationId:identity.localInstallationId,type:'qa.sale',schemaVersion:1,payload:{index}};
    const checked=validateEvent(event,{...identity,localInstallationId:identity.peerInstallationId,peerInstallationId:identity.localInstallationId});
    return {event_id:event.eventId,event_json:event,payload_hash:checked.hash,acked:false};
  });
  let locked=false,released=0,attempts=0;const committed=new Set(),lost=new Set();
  const connection={execute:async(sql,args)=>{
    if(sql.startsWith('SELECT GET_LOCK')){if(locked)return [[{acquired:0}]];locked=true;return [[{acquired:1}]];}
    if(sql.startsWith('SELECT RELEASE_LOCK')){locked=false;return [[{released:1}]];}
    if(sql.startsWith('SELECT event_id'))return [rows.filter(row=>!row.acked).slice(0,Number(sql.match(/LIMIT (\d+)$/)[1]))];
    if(sql.startsWith('UPDATE')){rows.find(row=>row.event_id===args[0]).acked=true;return [{}];}
    throw Error('Unexpected SQL');
  },release:()=>released++,destroy(){throw Error('Unexpected destroy');}};
  const flush=createOutboxSender({pool:{getConnection:async()=>connection},identity,send:async event=>{
    attempts++;committed.add(event.eventId);
    if(event.payload.index%101===0&&!lost.has(event.eventId)){lost.add(event.eventId);throw Error('Acknowledgment lost after commit');}
    return {eventId:event.eventId,committed:true};
  }});
  let batches=0;
  while(rows.some(row=>!row.acked)){
    batches++;assert.ok(batches<300);
    try{const result=await flush({limit:10});assert.ok(result.acknowledged<=10);}catch(error){assert.match(error.message,/Acknowledgment lost/);}
    assert.equal(locked,false);
  }
  assert.equal(committed.size,2160);assert.equal(attempts,2160+lost.size);assert.equal(released,batches);
});
