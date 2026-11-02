const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto'),fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
const {planEvidence,rebuildBaseline,assertDetached}=require('../services/recoveryBaselineRebuild');
const {validateEvent}=require('../services/syncEventProtocol');
const shopId='HFM001',baselineId='a'.repeat(64),ids=['hfm-local','hfm-cloud'];
const event=(origin=0,type='pos.product.fields.changed',payload={barcode:'TEST',changes:[{field:'sale_price',before:'10.00',after:'11.00'}]})=>({eventId:crypto.randomUUID(),shopId,originInstallationId:ids[origin],schemaVersion:1,type,payload});
const hash=e=>validateEvent(e,{shopId,peerInstallationId:e.originInstallationId,localInstallationId:ids.find(id=>id!==e.originInstallationId)}).hash;
const row=(e,sequence=1)=>({sequence_no:String(sequence),event_id:e.eventId,origin_installation_id:e.originInstallationId,event_json:e,payload_hash:hash(e)});
const receipt=e=>({event_id:e.eventId,origin_installation_id:e.originInstallationId,payload_hash:hash(e)});
const sides=()=>ids.map((installationId,i)=>({installationId,peerInstallationId:ids[1-i],outbox:[],inbox:[]}));
test('older local snapshot recovers own lost event from the peer archive without dropping cloud changes',()=>{
  const pair=sides(),a=event(0),b=event(1);pair[1].outbox=[row(a),row(b,2)];pair[1].inbox=[receipt(a)];
  const plan=planEvidence({shopId,baselineId,sides:pair});assert.deepEqual(plan.blockers,[]);assert.deepEqual(new Set(plan.missing[0]),new Set([a.eventId,b.eventId]));assert.deepEqual(plan.missing[1],[]);
});
test('receipt-only historical gaps and unproven received archives block rebuilding',()=>{
  const pair=sides(),a=event(0);pair[1].inbox=[receipt(a)];
  assert.equal(planEvidence({shopId,baselineId,sides:pair}).blockers[0].reason,'receipt-has-no-retained-event');
  pair[1].inbox=[];pair[1].outbox=[row(a)];assert.equal(planEvidence({shopId,baselineId,sides:pair}).blockers[0].reason,'received-archive-has-no-receipt');
});
test('same event identity with conflicting content or a different shop is never merged',()=>{
  const pair=sides(),a=event(0);pair[0].outbox=[row(a)];pair[1].outbox=[row({...a,payload:{barcode:'OTHER',changes:[]}})];
  assert.throws(()=>planEvidence({shopId,baselineId,sides:pair}),/conflicting payloads/);
  pair[1].outbox=[];pair[0].outbox[0].event_json.shopId='OTHER';assert.throws(()=>planEvidence({shopId,baselineId,sides:pair}),/identity mismatch/);
});
test('resolution runs before superseded source edits, independent of source sequence',()=>{
  const pair=sides(),a=event(0),resolution=event(0,'pos.recovery.product-resolved',{barcode:'TEST',changes:[],supersededEvents:[a]});pair[0].outbox=[row(a),row(resolution,2)];
  const plan=planEvidence({shopId,baselineId,sides:pair});assert.ok(plan.order.indexOf(resolution.eventId)<plan.order.indexOf(a.eventId));
});
test('payment match requires the original physical payment before resolution and supersedes duplicate event',()=>{
  const pair=sides(),incoming=event(1,'pos.supplier-payment.recorded',{payment:{id:'2'}}),local=event(0,'pos.supplier-payment.recorded',{payment:{id:'1'}});
  const resolution=event(0,'pos.recovery.supplier-payment-matched',{incomingEvent:incoming,localEvent:local,owner:{actor:'owner',note:'same payment',at:new Date().toISOString()}});
  pair[0].outbox=[row(local),row(resolution,2)];pair[0].inbox=[receipt(incoming)];pair[1].outbox=[row(incoming)];
  const plan=planEvidence({shopId,baselineId,sides:pair});assert.ok(plan.order.indexOf(incoming.eventId)<plan.order.indexOf(resolution.eventId));assert.ok(plan.order.indexOf(resolution.eventId)<plan.order.indexOf(local.eventId));
});
test('archive arrival order cannot contradict authoritative source sequence',()=>{
  const pair=sides(),a=event(0),b=event(0);pair[0].outbox=[row(a),row(b,2)];pair[1].outbox=[row(b),row(a,2)];pair[1].inbox=[receipt(a),receipt(b)];
  const plan=planEvidence({shopId,baselineId,sides:pair});assert.ok(plan.order.indexOf(a.eventId)<plan.order.indexOf(b.eventId));assert.deepEqual(plan.blockers,[]);
});
test('reviewed stock delta precedes covered audit events and retains the incoming audit dependency',()=>{
  const pair=sides(),incoming=event(1,'pos.stock.adjusted',{adjustment:{id:'2'}}),local=event(0,'pos.stock.adjusted',{adjustment:{id:'1'}});
  const resolution=event(0,'pos.recovery.stock-deltas-reviewed',{incomingEvent:incoming,localEvents:[local],owner:{actor:'owner',note:'reviewed movements',at:new Date().toISOString()},decision:{kind:'accept-stock-audit-delta'}});
  pair[0].outbox=[row(local),row(resolution,2)];pair[0].inbox=[receipt(incoming)];pair[1].outbox=[row(incoming)];
  const plan=planEvidence({shopId,baselineId,sides:pair});assert.ok(plan.order.indexOf(incoming.eventId)<plan.order.indexOf(resolution.eventId));assert.ok(plan.order.indexOf(resolution.eventId)<plan.order.indexOf(local.eventId));
});
async function fixture(t){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'badizo-rebuild-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const evidence=sides(),configuration={shopId,baselineId,sides:[]};
  for(let i=0;i<2;i++){
    const originalRuntimeBinding=path.join(root,i+'-binding.json');await fs.writeFile(originalRuntimeBinding,JSON.stringify({shopId,database:{database:i?'cloud_original':'local_original'}}));
    configuration.sides.push({installationId:ids[i],peerInstallationId:ids[1-i],databaseName:'badizo_recovery_rebuild0'+i,originalRuntimeBinding});
  }
  const pools=evidence.map((side,index)=>({getConnection:async()=>({
    query:async sql=>sql.startsWith('SELECT DATABASE')?[[{name:configuration.sides[index].databaseName,version:'8.0.46'}]]:[[]],
    execute:async(sql,args)=>{
      if(sql.includes('GET_LOCK'))return [[{acquired:1}]];
      if(sql.includes('RELEASE_LOCK'))return [[{}]];
      if(sql.includes('FROM sync_enrollment'))return [[{shop_id:shopId,installation_id:ids[index],peer_installation_id:ids[1-index],baseline_id:baselineId,contract_version:1}]];
      if(sql.includes('FROM sync_outbox'))return [side.outbox.filter(row=>BigInt(row.sequence_no)>BigInt(args[3])).slice(0,100)];
      if(sql.includes('FROM sync_inbox'))return [side.inbox];throw Error('Unexpected SQL '+sql);
    },rollback:async()=>{},release(){}})}));
  return {root,evidence,pools,configuration,reportPath:path.join(root,'report.json')};
}
test('detached executor resumes after lost acknowledgement without applying a transaction twice',async t=>{
  const f=await fixture(t),a=event(0),b=event(1);f.evidence[1].outbox=[row(a),row(b,2)];f.evidence[1].inbox=[receipt(a)];
  let changes=0,lost=false;
  const receiveFactory=({pool,retainReceived})=>async e=>{
    assert.equal(retainReceived,true);const side=f.evidence[f.pools.indexOf(pool)],duplicate=side.inbox.some(r=>r.event_id===e.eventId);
    if(!duplicate){changes++;side.inbox.push(receipt(e));side.outbox.push(row(e,side.outbox.length+1));}
    if(e.eventId===a.eventId&&!lost){lost=true;throw Error('Reply lost after commit');}
    return {committed:true,duplicate};
  };
  const result=await rebuildBaseline({...f,apply:true,receiveFactory});assert.equal(result.state,'retained-events-reconciled');assert.equal(changes,2);assert.equal(result.readyForEnrollment,false);assert.equal(result.syncEnabled,false);
  const again=await rebuildBaseline({...f,apply:true,receiveFactory});assert.deepEqual(again.remaining,[0,0]);assert.equal(changes,2);assert.equal(again.previousRuns.length,1);
});
test('a restored recovery-prefixed database currently used for local billing is rejected before writes',async t=>{
  const f=await fixture(t);await fs.writeFile(f.configuration.sides[0].originalRuntimeBinding,JSON.stringify({shopId,database:{database:f.configuration.sides[0].databaseName}}));
  await assert.rejects(assertDetached(f.configuration),/bound to live/);
  await assert.rejects(rebuildBaseline({...f,apply:true,receiveFactory:()=>{throw Error('Must not reach receiver');}}),/bound to live/);
});
test('missing provenance stops before any event executor is constructed',async t=>{
  const f=await fixture(t);f.evidence[1].inbox=[receipt(event(0))];
  const result=await rebuildBaseline({...f,apply:true,receiveFactory:()=>{throw Error('Must not execute');}});assert.equal(result.state,'blocked');assert.deepEqual(result.applied,[]);
});
