const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const {canonical,validateEvent,createSyncReceiver}=require('../services/syncEventProtocol');
const {createFinancialCorrectionExecution,applyMatchedSupplierPayment,applyReviewedStockDeltas,validatePair,verifyAuditChain}=require('../services/financialCorrectionExecution');
const identity={shopId:'HFM001',localInstallationId:'local-test',peerInstallationId:'cloud-test'},reverse={shopId:'HFM001',localInstallationId:'cloud-test',peerInstallationId:'local-test'};
const envelope=(origin,type,payload)=>({eventId:crypto.randomUUID(),shopId:'HFM001',originInstallationId:origin,type,schemaVersion:1,payload});
function payment(origin,id){return envelope(origin,'pos.supplier-payment.recorded',{payment:{id:String(id),inward_no:'TEST-INWARD',supplier_name:'Supplier',supplier_gstin:'',payment_date:'2026-11-02',amount:'70.00',payment_mode:'Bank Transfer',reference_no:'ONE-PHYSICAL-PAYMENT',notes:'Original evidence',created_by:'owner',created_at:'2026-11-02 10:00:00'},before:{grand_total:'100.00',paid_amount:'0.00',due_amount:'100.00'},after:{grand_total:'100.00',paid_amount:'70.00',due_amount:'30.00'}});}
function stock(origin,id,before,delta){return envelope(origin,'pos.stock.adjusted',{adjustment:{id:String(id),barcode:'P',product_name:'Product',old_qty:before.toFixed(2),adjustment_qty:delta.toFixed(2),new_qty:(before+delta).toFixed(2),reason:'STOCK_AUDIT',note:'Independent physical difference',created_by:'owner',created_at:'2026-11-02 10:00:00'}});}
const options={expectedRevision:0,actor:'owner',note:'Verified original records and independently checked the physical evidence.'};
function db({events=[],payments=[],stockQty='105.00',batches=false}={}){
  let committed={events:events.map(event=>({event_json:canonical(event),payload_hash:validateEvent(event,{shopId:'HFM001',peerInstallationId:event.originInstallationId,localInstallationId:event.originInstallationId==='local-test'?'cloud-test':'local-test'}).hash,ack:false})),payments:structuredClone(payments),stock:stockQty,batches,receipts:{},applications:{},paymentMaps:[],stockMaps:[],adjustments:[]};
  let fail=false;
  const pool={async getConnection(){let state;return {
    async beginTransaction(){state=structuredClone(committed);},async commit(){committed=state;},async rollback(){state=null;},release(){},
    async query({sql},args){if(sql.startsWith('SELECT * FROM supplier_payments'))return [state.payments.filter(p=>String(p.id)===String(args[0]))];throw Error('Unhandled query '+sql);},
    async execute(sql,args){
      if(sql.startsWith('SELECT head_hash FROM sync_recovery_applications'))return [[...(state.applications[args[1]]?[state.applications[args[1]]]:[])]];
      if(sql.startsWith('SELECT payload_hash FROM sync_inbox'))return [[...(state.receipts[args[1]]?[{payload_hash:state.receipts[args[1]]}]:[])]];
      if(sql.startsWith('SELECT event_json,payload_hash FROM sync_outbox WHERE event_id='))return [state.events.filter(row=>JSON.parse(row.event_json).eventId===args[0])];
      if(sql.startsWith('SELECT event_json,payload_hash FROM sync_outbox'))return [state.events.filter(row=>{
        const e=JSON.parse(row.event_json);if(e.originInstallationId!==args[1])return false;
        if(sql.includes('AND event_id=?'))return e.eventId===args[2];
        if(row.ack)return false;
        return sql.includes("'$.payload.payment.id'")?e.type==='pos.supplier-payment.recorded'&&String(e.payload.payment.id)===String(args[2]):e.type==='pos.stock.adjusted'&&e.payload.adjustment.barcode===args[2];
      })];
      if(sql.startsWith('SELECT supplier_name,supplier_gstin'))return [[{supplier_name:'Supplier',supplier_gstin:'',posting_status:'POSTED',grand_total:'100.00',paid_amount:'70.00',due_amount:'30.00'}]];
      if(sql.startsWith('SELECT stock_qty,product_name'))return [[{stock_qty:state.stock,product_name:'Product'}]];
      if(sql.startsWith('SELECT id FROM product_batches'))return [state.batches?[{id:1}]:[]];
      if(sql.startsWith('INSERT INTO sync_inbox')){if(state.receipts[args[1]])throw Object.assign(Error('duplicate'),{code:'ER_DUP_ENTRY'});state.receipts[args[1]]=args[3];return [{}];}
      if(sql.startsWith('INSERT INTO sync_outbox')){if(state.events.some(row=>JSON.parse(row.event_json).eventId===args[0]))throw Object.assign(Error('duplicate'),{code:'ER_DUP_ENTRY'});state.events.push({event_json:args[3],payload_hash:args[4],ack:sql.includes('CURRENT_TIMESTAMP')});return [{}];}
      if(sql.startsWith('INSERT INTO sync_recovery_applications')){state.applications[args[1]]={head_hash:args[3],review_json:args[5]};return [{}];}
      if(sql.startsWith('INSERT INTO sync_supplier_payment_map')){if(state.paymentMaps.some(row=>row[3]===args[3]))throw Error('Ambiguous payment target');state.paymentMaps.push(args);return [{}];}
      if(sql.startsWith('INSERT INTO sync_stock_adjustment_map')){if(fail)throw Error('Interrupted map write');state.stockMaps.push(args);return [{}];}
      if(sql.startsWith('INSERT INTO stock_adjustments')){state.adjustments.push(args);return [{insertId:state.adjustments.length}];}
      if(sql.startsWith('UPDATE sync_stock_adjustment_map'))return [{}];
      if(sql.startsWith('UPDATE products SET stock_qty=')){state.stock=args[0];return [{}];}
      throw Error('Unhandled execute '+sql);
    }
  };}};
  return {pool,state:()=>structuredClone(committed),failMap:()=>{fail=true;}};
}
const executor=(database,id=identity)=>createFinancialCorrectionExecution({pool:database.pool,identity:id,nodeRole:'local-server',canApply:async()=>true});
test('matching requires exact payment identity and common balances; equal amounts alone are insufficient',()=>{
  const a=payment('cloud-test',1),b=payment('local-test',2);assert.equal(validatePair(a,b).amount,7000n);
  assert.throws(()=>validatePair(a,{...b,payload:{...b.payload,payment:{...b.payload.payment,reference_no:'SECOND-PAYMENT'}}}),/same reviewed/);
  assert.throws(()=>validatePair(a,{...b,payload:{...b.payload,before:{grand_total:'200.00',paid_amount:'0.00',due_amount:'200.00'},after:{grand_total:'200.00',paid_amount:'70.00',due_amount:'130.00'}}}),/same reviewed/);
});
test('matching keeps both original payments and balances, and peer originals become duplicate-safe',async()=>{
  const local=payment('local-test',10),cloud=payment('cloud-test',20),a=db({events:[local],payments:[local.payload.payment]}),b=db({events:[cloud],payments:[cloud.payload.payment]});
  const result=await executor(a).matchPayment(cloud,{...options,targetPaymentId:'10'});assert.equal(result.requiresPeerDelivery,true);
  assert.deepEqual(a.state().payments,[local.payload.payment]);assert.ok(a.state().receipts[cloud.eventId]);
  const resolution=a.state().events.map(row=>JSON.parse(row.event_json)).find(e=>e.type==='pos.recovery.supplier-payment-matched');
  const receive=createSyncReceiver({pool:b.pool,identity:reverse,handlers:{'pos.recovery.supplier-payment-matched':applyMatchedSupplierPayment,'pos.supplier-payment.recorded':()=>assert.fail('Original payment must not apply again')}});
  await receive(resolution);assert.equal((await receive(resolution)).duplicate,true);assert.equal((await receive(local)).duplicate,true);
  assert.deepEqual(b.state().payments,[cloud.payload.payment]);assert.equal(b.state().paymentMaps.length,1);
  assert.equal((await executor(a).matchPayment(cloud,{...options,targetPaymentId:'10'})).duplicate,true);
});
test('stock acceptance preserves independent receiving stock, and rollback retains the original for retry',async()=>{
  const event=stock('cloud-test',1,100,3),a=db();
  await assert.rejects(executor(a).acceptStockDelta(event,{...options,expectedStock:'104.00',expectedLocalAuditIds:[]}),/Stock changed/);assert.equal(a.state().stock,'105.00');assert.deepEqual(a.state().receipts,{});
  a.failMap();await assert.rejects(executor(a).acceptStockDelta(event,{...options,expectedStock:'105.00',expectedLocalAuditIds:[]}),/Interrupted/);assert.equal(a.state().stock,'105.00');assert.deepEqual(a.state().receipts,{});
  const b=db();await executor(b).acceptStockDelta(event,{...options,expectedStock:'105.00',expectedLocalAuditIds:[]});assert.equal(b.state().stock,'108.00');assert.equal(b.state().adjustments.length,1);
  assert.equal((await executor(b).acceptStockDelta(event,{...options,expectedStock:'105.00',expectedLocalAuditIds:[]})).duplicate,true);assert.equal(b.state().stock,'108.00');
});
test('two independently reviewed stock audits converge once; stale peer stock refuses the resolution',async()=>{
  const local=stock('local-test',10,100,5),cloud=stock('cloud-test',20,100,3),a=db({events:[local]}),b=db({events:[cloud],stockQty:'103.00'});
  const decision={...options,expectedStock:'105.00',expectedLocalAuditIds:[local.eventId]};await executor(a).acceptStockDelta(cloud,decision);
  const resolution=a.state().events.map(row=>JSON.parse(row.event_json)).find(e=>e.type==='pos.recovery.stock-deltas-reviewed');assert.ok(resolution);
  const receive=createSyncReceiver({pool:b.pool,identity:reverse,handlers:{'pos.recovery.stock-deltas-reviewed':applyReviewedStockDeltas,'pos.stock.adjusted':()=>assert.fail('Reviewed delta must not apply again')}});
  await receive(resolution);assert.equal((await receive(resolution)).duplicate,true);assert.equal((await receive(local)).duplicate,true);assert.equal(a.state().stock,'108.00');assert.equal(b.state().stock,'108.00');
  assert.equal((await executor(a).acceptStockDelta(cloud,decision)).requiresPeerDelivery,true);
  const changed=db({events:[cloud],stockQty:'102.00'}),reject=createSyncReceiver({pool:changed.pool,identity:reverse,handlers:{'pos.recovery.stock-deltas-reviewed':applyReviewedStockDeltas}});
  await assert.rejects(reject(resolution),/Stock changed/);assert.equal(changed.state().stock,'102.00');assert.deepEqual(changed.state().receipts,{});
});
test('malformed stock, changed audit lists, batches and cloud-side correction authority fail closed',async()=>{
  const event=stock('cloud-test',1,100,3),a=db();
  await assert.rejects(executor(a).acceptStockDelta({...event,payload:{adjustment:{...event.payload.adjustment,created_at:'invalid'}}},{...options,expectedStock:'105.00',expectedLocalAuditIds:[]}),/ordinary stock audit/);
  await assert.rejects(executor(a).acceptStockDelta(event,{...options,expectedStock:'105.00',expectedLocalAuditIds:['unreviewed']}),/changed since/);
  await assert.rejects(executor(db({batches:true})).acceptStockDelta(event,{...options,expectedStock:'105.00',expectedLocalAuditIds:[]}),/Batch stock/);
  await assert.rejects(createFinancialCorrectionExecution({pool:{},identity,nodeRole:'cloud-standby',canApply:async()=>true}).acceptStockDelta(event,{...options,expectedStock:'105.00',expectedLocalAuditIds:[]}),/local server/);
  assert.throws(()=>verifyAuditChain(event,[stock('local-test',2,99,6)],10500n),/common baseline/);
});
