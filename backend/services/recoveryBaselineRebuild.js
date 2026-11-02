const crypto=require('node:crypto');
const {canonical,validateEvent,createSyncReceiver}=require('./syncEventProtocol');
const {handlers}=require('./posSyncReceiver');
const {atomic,json}=require('./recoveryControlFiles');
const path=require('node:path');
const digest=value=>crypto.createHash('sha256').update(canonical(value)).digest('hex');
const allowedDatabase=name=>/^badizo_recovery_[a-z0-9]{8,32}$/.test(name||'');

// Evidence means a transactionally retained event/receipt, not a claim that
// every business edit ever made was captured. Missing history stays a blocker.
function planEvidence({shopId,baselineId,sides}){
  if(!/^[A-Z][A-Z0-9_-]{2,31}$/.test(shopId||'')||!/^[a-f0-9]{64}$/.test(baselineId||'')||!Array.isArray(sides)||sides.length!==2)throw Error('Invalid recovery baseline.');
  const ids=sides.map(side=>side.installationId);
  if(ids[0]===ids[1]||ids.some(id=>!/^[A-Za-z0-9_-]{3,64}$/.test(id||'')))throw Error('Distinct original installation identities required.');
  const events=new Map(),orders=[[],[]],receipts=[new Map(),new Map()],own=[new Set(),new Set()],blockers=[];
  function add(event,hash){
    const origin=ids.indexOf(event.originInstallationId);
    if(origin<0)throw Error('Unexpected recovery event origin.');
    const checked=validateEvent(event,{shopId,peerInstallationId:ids[origin],localInstallationId:ids[1-origin]});
    if(hash!==checked.hash)throw Error('Recovery event hash differs from retained evidence.');
    const previous=events.get(event.eventId);
    if(previous&&previous.hash!==hash)throw Error('Recovery event identity has conflicting payloads.');
    if(!previous)events.set(event.eventId,{event:JSON.parse(checked.serialized),hash,origin});
    return event.eventId;
  }
  for(let index=0;index<2;index++){
    const side=sides[index];
    if(side.peerInstallationId!==ids[1-index]||!Array.isArray(side.outbox)||!Array.isArray(side.inbox))throw Error('Recovery peer identity differs.');
    let last=0n;
    for(const row of side.outbox){
      if(typeof row.sequence_no==='number'&&!Number.isSafeInteger(row.sequence_no))throw Error('Recovery sequence requires exact integer encoding.');
      const sequence=BigInt(row.sequence_no);if(sequence<=last)throw Error('Recovery event sequence is not ordered.');last=sequence;
      const event=typeof row.event_json==='string'?JSON.parse(row.event_json):row.event_json;
      if(row.event_id!==event?.eventId||row.origin_installation_id!==event?.originInstallationId)throw Error('Retained event columns differ from its envelope identity.');
      const id=add(event,row.payload_hash);orders[index].push(id);
      if(event.originInstallationId===ids[index])own[index].add(id);
    }
    for(const row of side.inbox){
      if(!ids.includes(row.origin_installation_id)||receipts[index].has(row.event_id))throw Error('Invalid recovery receipt identity.');
      receipts[index].set(row.event_id,row);
    }
  }
  // Resolutions contain exact originals that were acknowledged without being
  // independently applied. Retain those identities but replay the resolution
  // first. Never apply a superseded price edit before its reviewed decision.
  const covered=new Map(),resolutionDependencies=[];
  for(const [id,record] of [...events]){
    let originals=[];
    if(record.event.type==='pos.recovery.product-resolved'){
      if(!Array.isArray(record.event.payload.supersededEvents))throw Error('Invalid retained resolution evidence.');
      originals=record.event.payload.supersededEvents;
    }else if(['pos.recovery.supplier-payment-matched','pos.recovery.stock-deltas-reviewed'].includes(record.event.type)){
      const {incomingEvent,localEvent,localEvents}=record.event.payload;
      const expectedType=record.event.type==='pos.recovery.supplier-payment-matched'?'pos.supplier-payment.recorded':'pos.stock.adjusted';
      const local=record.event.type==='pos.recovery.supplier-payment-matched'?[localEvent]:localEvents;
      if(incomingEvent?.type!==expectedType||!Array.isArray(local)||local.some(event=>event?.type!==expectedType||event.originInstallationId!==ids[record.origin])||incomingEvent.originInstallationId!==ids[1-record.origin])throw Error('Invalid retained financial resolution.');
      const incoming=validateEvent(incomingEvent,{shopId,peerInstallationId:ids[1-record.origin],localInstallationId:ids[record.origin]});
      add(incomingEvent,incoming.hash);originals=local;resolutionDependencies.push([incomingEvent.eventId,id]);
      if(own[record.origin].has(id)&&!receipts[record.origin].has(incomingEvent.eventId))blockers.push({side:record.origin,eventId:id,reason:'resolution-receipt-missing'});
    }
    for(const original of originals){
      const checked=validateEvent(original,{shopId,peerInstallationId:record.event.originInstallationId,localInstallationId:ids[1-record.origin]});
      add(original,checked.hash);
      if(covered.has(original.eventId)&&covered.get(original.eventId)!==id)throw Error('Original event has competing retained resolutions.');
      covered.set(original.eventId,id);
    }
  }
  for(let index=0;index<2;index++)for(const [id,row] of receipts[index]){
    const record=events.get(id);
    if(!record)blockers.push({side:index,eventId:id,reason:'receipt-has-no-retained-event'});
    else if(record.hash!==row.payload_hash||record.event.originInstallationId!==row.origin_installation_id)throw Error('Recovery receipt hash/origin differs from event evidence.');
  }
  // A received archive without its atomic receipt cannot prove application.
  for(let index=0;index<2;index++)for(const id of orders[index])if(!own[index].has(id)&&!receipts[index].has(id))blockers.push({side:index,eventId:id,reason:'received-archive-has-no-receipt'});
  const missing=[[],[]];
  for(let index=0;index<2;index++)for(const [id,record] of events){
    if(own[index].has(id)||receipts[index].has(id))continue;
    if(record.origin===index&&record.event.type.startsWith('pos.recovery.'))blockers.push({side:index,eventId:id,reason:'originating-resolution-needs-original-review'});
    if(!Object.hasOwn(handlers,record.event.type))blockers.push({side:index,eventId:id,reason:'unsupported-recovery-event'});
    missing[index].push(id);
  }
  // Only original own-capture sequence proves source order. Received archive
  // sequence is arrival order (duplicate backfill can arrive much later).
  // A self-origin inbox receipt marks an own event recovered from the peer.
  const edges=new Map([...events.keys()].map(id=>[id,new Set()])),indegree=new Map([...events.keys()].map(id=>[id,0]));
  const edge=(a,b)=>{if(a===b||edges.get(a).has(b))return;edges.get(a).add(b);indegree.set(b,indegree.get(b)+1);};
  for(let side=0;side<2;side++){const selected=orders[side].filter(id=>events.get(id).origin===side&&!receipts[side].has(id)&&!covered.has(id));for(let i=1;i<selected.length;i++)edge(selected[i-1],selected[i]);}
  for(const [original,resolution] of covered)edge(resolution,original);
  for(const [before,after] of resolutionDependencies)edge(before,after);
  const queue=[...indegree].filter(([,n])=>n===0).map(([id])=>id).sort(),order=[];
  while(queue.length){const id=queue.shift();order.push(id);for(const next of edges.get(id)){indegree.set(next,indegree.get(next)-1);if(indegree.get(next)===0){queue.push(next);queue.sort();}}}
  if(order.length!==events.size)throw Error('Retained event order is inconsistent.');
  const evidenceHash=digest({shopId,baselineId,ids,events:[...events].map(([id,record])=>[id,record.hash]).sort(),orders});
  const predecessors=new Map([...events.keys()].map(id=>[id,new Set()]));for(const [before,next] of edges)for(const after of next)predecessors.get(after).add(before);
  return {shopId,baselineId,ids,events,order,missing,blockers,evidenceHash,covered,predecessors};
}

async function readEvidence(pool,{shopId,installationId,peerInstallationId,baselineId,databaseName,maxEvents=10000,maxBytes=64*1024*1024}){
  if(!allowedDatabase(databaseName)||!Number.isSafeInteger(maxEvents)||maxEvents<1||maxEvents>100000||!Number.isSafeInteger(maxBytes)||maxBytes<1024||maxBytes>256*1024*1024)throw Error('Detached recovery database and bounded evidence limits required.');
  const connection=await pool.getConnection();
  try{
    await connection.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
    await connection.query('START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY');
    const [[db]]=await connection.query('SELECT DATABASE() AS name,VERSION() AS version');
    if(db.name!==databaseName||!/^8\.0\./.test(db.version))throw Error('Unexpected recovery database/version.');
    const [enrollment]=await connection.execute('SELECT * FROM sync_enrollment WHERE singleton=1');
    const row=enrollment[0];
    if(enrollment.length!==1||row.shop_id!==shopId||row.installation_id!==installationId||row.peer_installation_id!==peerInstallationId||row.baseline_id!==baselineId||Number(row.contract_version)!==1)throw Error('Staged copy does not belong to its original enrolled baseline.');
    const outbox=[];let after='0',bytes=0;
    for(;;){
      const [batch]=await connection.execute('SELECT sequence_no,event_id,origin_installation_id,event_json,payload_hash FROM sync_outbox WHERE shop_id=? AND origin_installation_id IN (?,?) AND sequence_no>? ORDER BY sequence_no LIMIT 100',[shopId,installationId,peerInstallationId,after]);
      for(const event of batch){bytes+=Buffer.byteLength(typeof event.event_json==='string'?event.event_json:JSON.stringify(event.event_json));if(bytes>maxBytes||outbox.length>=maxEvents)throw Error('Recovery evidence exceeds bounded run limits.');outbox.push(event);}
      if(batch.length<100)break;after=String(batch[batch.length-1].sequence_no);
    }
    const [inbox]=await connection.execute('SELECT event_id,origin_installation_id,payload_hash FROM sync_inbox WHERE shop_id=? AND origin_installation_id IN (?,?) ORDER BY event_id LIMIT '+(maxEvents+1),[shopId,installationId,peerInstallationId]);
    if(inbox.length>maxEvents)throw Error('Recovery receipts exceed bounded run limits.');
    return {installationId,peerInstallationId,outbox,inbox};
  }finally{await connection.rollback().catch(()=>{});connection.release();}
}

async function assertDetached(configuration){
  const databases=configuration.sides.map(side=>side.databaseName);
  for(const side of configuration.sides){
    if(!path.isAbsolute(side.originalRuntimeBinding||''))throw Error('Protected live binding paths are required for staged execution.');
    const binding=await json(side.originalRuntimeBinding);
    if(binding.shopId!==configuration.shopId||!binding.database?.database||databases.includes(binding.database.database))throw Error('A staging database is bound to live POS billing.');
  }
}

async function rebuildBaseline({pools,configuration,reportPath,apply=false,receiveFactory=createSyncReceiver}){
  const {shopId,baselineId,sides}=configuration||{};
  if(!Array.isArray(pools)||pools.length!==2||!Array.isArray(sides)||sides.length!==2||!path.isAbsolute(reportPath||'')||sides[0].databaseName===sides[1].databaseName||sides.some(side=>!allowedDatabase(side.databaseName)))throw Error('Two different detached recovery databases and protected report path required.');
  const locks=[];
  try{
    if(apply)await assertDetached(configuration);
    for(let i=0;i<2;i++){
      const connection=await pools[i].getConnection();locks.push(connection);
      const [[locked]]=await connection.execute('SELECT GET_LOCK(?,0) AS acquired',['badizo-rebuild:'+sides[i].databaseName]);
      if(Number(locked.acquired)!==1)throw Error('Another staged recovery operation is running.');
    }
    const evidence=await Promise.all(pools.map((pool,index)=>readEvidence(pool,{...sides[index],shopId,baselineId})));
    const plan=planEvidence({shopId,baselineId,sides:evidence});
    const report={schemaVersion:1,shopId,baselineId,evidenceHash:plan.evidenceHash,databases:sides.map(side=>side.databaseName),state:plan.blockers.length?'blocked':'planned',blockers:plan.blockers,missing:plan.missing.map(ids=>ids.length),applied:[],startedAt:new Date().toISOString(),syncEnabled:false,readyForEnrollment:false,captureContinuityVerified:false};
    try{
      const previous=await json(reportPath);if(previous.shopId!==shopId||previous.baselineId!==baselineId||canonical(previous.databases)!==canonical(report.databases))throw Error('Recovery report belongs to another operation.');
      report.previousRuns=[...(previous.previousRuns||[]),{state:previous.state,evidenceHash:previous.evidenceHash,applied:previous.applied,startedAt:previous.startedAt,finishedAt:previous.finishedAt||null}];
      if(report.previousRuns.length>1000)throw Error('Recovery journal needs archival before another run.');
    }catch(error){if(error.code!=='ENOENT')throw error;}
    await atomic(reportPath,report);
    if(!apply||plan.blockers.length)return report;
    const pending=plan.missing.map(ids=>new Set(ids)),failures=new Map();
    const receivers=pools.map(pool=>plan.ids.map((origin,index)=>receiveFactory({pool,identity:{shopId,peerInstallationId:origin,localInstallationId:plan.ids[1-index]},handlers,retainReceived:true})));
    // Each event commits business effects, receipt and retained replay evidence
    // together. A crash can resume from receipts without replaying a payment.
    for(let pass=0;pass<plan.events.size+1;pass++){
      let progress=false;
      for(let side=0;side<2;side++)for(const id of plan.order){
        if(!pending[side].has(id))continue;
        const record=plan.events.get(id);
        if([...plan.predecessors.get(id)].some(before=>pending[side].has(before)))continue;
        await assertDetached(configuration);
        try{
          const result=await receivers[side][record.origin](record.event);
          if(result.committed!==true)throw Error('Receiver did not commit.');
          pending[side].delete(id);failures.delete(side+':'+id);progress=true;
          report.applied.push({side,eventId:id,type:record.event.type,duplicate:!!result.duplicate});report.state='replaying';await atomic(reportPath,report);
        }catch(error){failures.set(side+':'+id,{side,eventId:id,type:record.event.type,reason:error.code?'database-rejected':'domain-reconciliation-required'});}
      }
      if(pending.every(set=>set.size===0)||!progress)break;
    }
    report.remaining=pending.map(set=>set.size);report.blockers=[...failures.values()];
    report.state=pending.some(set=>set.size)?'needs-correction':'retained-events-reconciled';report.finishedAt=new Date().toISOString();
    // No automatic fresh baseline: events cannot prove absence of edits made
    // with capture disabled, or identify events lost on both original nodes.
    report.enrollmentBlockers=['verify-capture-continuity-and-unlogged-restored-billing','verify-business-record-and-stock-convergence','activate-verified-pair-with-protected-enrollment'];
    await atomic(reportPath,report);return report;
  }finally{
    for(let i=locks.length-1;i>=0;i--){try{await locks[i].execute('SELECT RELEASE_LOCK(?)',['badizo-rebuild:'+sides[i].databaseName]);}catch{}locks[i].release();}
  }
}
module.exports={planEvidence,readEvidence,rebuildBaseline,allowedDatabase,assertDetached};
