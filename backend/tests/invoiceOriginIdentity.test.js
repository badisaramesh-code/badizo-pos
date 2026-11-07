const test=require('node:test'),assert=require('node:assert/strict');
const {normalizeLifecycle,lifecycleContext}=require('../services/invoiceOriginIdentity');
const original={invoice:{id:'1',invoice_no:'CL/1',invoice_status:'PAID'},items:[{id:'2',invoice_no:'CL/1',barcode:'P',returned_qty:'0.00'}],payments:[{id:'3',invoice_no:'CL/1',amount:'10.00'}],batchAllocations:[{id:'4',invoice_no:'CL/1',invoice_item_id:'2',returned_qty:'0.00'}],loyaltyTransactions:[]};
const payload={invoice:{...original.invoice,id:'101',invoice_status:'RETURNED'},items:[{...original.items[0],id:'102',returned_qty:'1.00'}],payments:[{...original.payments[0],id:'103'}],batchAllocations:[{...original.batchAllocations[0],id:'104',invoice_item_id:'102',returned_qty:'1.00'}],loyaltyTransactions:[],returns:[{invoice_no:'CL/1'}],returnItems:[{invoice_item_id:'102'}],change:{kind:'return',returnNo:'RET/1'}};
function connection(){return {query:async({sql})=>{
  if(sql.includes('FROM sync_invoice_map'))return [[{origin_installation_id:'cloud',source_invoice_no:'CL/1',checkout_payload:JSON.stringify(original)}]];
  if(sql.includes('FROM sync_invoice_item_map'))return [[{source_item_id:'2',target_item_id:'102'}]];
  if(sql.includes('FROM sync_invoice_batch_map'))return [[{source_allocation_id:'4',target_allocation_id:'104'}]];
  throw Error('Unexpected SQL');
}};}
test('received invoice lifecycle translates every numeric identity back to its recorded origin',async()=>{
  const translated=await normalizeLifecycle(connection(),payload,{shopId:'HFM001',localInstallationId:'local',peerInstallationId:'cloud'});
  assert.equal(translated.checkoutOrigin,'cloud');assert.equal(translated.invoice.id,'1');assert.equal(translated.items[0].id,'2');assert.equal(translated.items[0].returned_qty,'1.00');assert.equal(translated.batchAllocations[0].id,'4');assert.equal(translated.batchAllocations[0].invoice_item_id,'2');assert.equal(translated.returnItems[0].invoice_item_id,'2');assert.deepEqual(translated.payments,original.payments);assert.equal(payload.items[0].id,'102');
});
test('changed payments and unknown original installations cannot be silently translated',async()=>{
  await assert.rejects(normalizeLifecycle(connection(),{...payload,payments:[{...payload.payments[0],amount:'9.00'}]},{shopId:'HFM001',localInstallationId:'local',peerInstallationId:'cloud'}),/payment details changed/);
  await assert.rejects(lifecycleContext({}, {...payload,checkoutOrigin:'third-shop'}, {shopId:'HFM001',originInstallationId:'local',localInstallationId:'cloud'}),/Unknown checkout origin/);
});
test('ordinary origin lifecycle retains legacy behavior without additional receiver queries',async()=>{
  const context={shopId:'HFM001',originInstallationId:'cloud',localInstallationId:'local'};assert.equal(await lifecycleContext({},payload,context),context);
});
test('historical capture never touches disabled installations',async()=>{
  const {captureHistoricalBaseline}=require('../services/invoiceOriginIdentity');
  assert.equal(await captureHistoricalBaseline({},'OLD/1',{}),null);
});
test('historical baseline mismatch stops before creating mappings or changing stock',async()=>{
  const baseline={invoice:{id:'1',invoice_no:'OLD/1',invoice_status:'PAID',exchange_total:'0.00',exchange_items_json:null,loyalty_redeemed_points:0,loyalty_redeemed_amount:0},items:[{id:'2',invoice_no:'OLD/1',returned_qty:0,is_free_bonus:0,free_offer_id:null}],payments:[],batchAllocations:[],loyaltyTransactions:[]};
  const connection={execute:async sql=>{assert.match(sql,/^SELECT target_invoice_no FROM sync_invoice_map/);return [[]];},query:async({sql})=>{
    const table=/FROM (\w+)/.exec(sql)[1];
    if(table==='invoices')return [[{...baseline.invoice,customer_name:'independent change'}]];
    return [table==='invoice_items'?baseline.items:[]];
  }};
  await assert.rejects(lifecycleContext(connection,{invoice:baseline.invoice,checkoutBaseline:baseline},{shopId:'HFM001',originInstallationId:'local',localInstallationId:'cloud'}),/differs from the backup baseline/);
});
test('identical historical snapshots establish only identity mappings, never replay the sale',async()=>{
  const baseline={invoice:{id:'1',invoice_no:'OLD/2',invoice_status:'PAID',exchange_total:'0.00',exchange_items_json:null,loyalty_redeemed_points:0,loyalty_redeemed_amount:0},items:[{id:'2',invoice_no:'OLD/2',barcode:'P',returned_qty:0,is_free_bonus:0,free_offer_id:null}],payments:[],batchAllocations:[],loyaltyTransactions:[]};
  const writes=[];
  const connection={execute:async(sql,args)=>{
    if(sql.startsWith('SELECT'))return [[]];
    assert.match(sql,/^INSERT INTO sync_invoice_(map|item_map) /);writes.push({sql,args});return [{}];
  },query:async({sql})=>{
    const table=/FROM (\w+)/.exec(sql)[1];return [table==='invoices'?[baseline.invoice]:table==='invoice_items'?baseline.items:[]];
  }};
  const context={shopId:'HFM001',originInstallationId:'local',localInstallationId:'cloud'};
  assert.deepEqual(await lifecycleContext(connection,{invoice:baseline.invoice,checkoutBaseline:baseline},context),context);
  assert.equal(writes.length,2);assert.equal(writes[0].args[1],'local');assert.deepEqual(JSON.parse(writes[0].args[4]),baseline);
});
