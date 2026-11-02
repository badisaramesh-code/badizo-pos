// Real HTTP/MySQL acceptance checks. Run only against already-started isolated
// POS processes with notifications/scheduled jobs disabled. This tool never
// creates, drops, restores, or re-enrolls a database or changes a billing mode.
const assert=require('node:assert/strict'),crypto=require('node:crypto'),http=require('node:http');
function endpoint(base,route){
  const url=new URL(base);
  assert.ok(['http:','https:'].includes(url.protocol)&&['127.0.0.1','localhost','[::1]'].includes(url.hostname),'Acceptance endpoints must be loopback only.');
  assert.ok(!url.username&&!url.password&&!url.search&&!url.hash);
  return new URL('/api/'+route,url).href;
}
async function request(base,route,token,body,headers={}){
  const response=await fetch(endpoint(base,route),{method:body===undefined?'GET':'POST',redirect:'error',signal:AbortSignal.timeout(15000),headers:{Authorization:'Bearer '+token,'Content-Type':'application/json',...headers},...(body===undefined?{}:{body:JSON.stringify(body)})});
  return {status:response.status,data:await response.json()};
}
async function committedEvent(pool,installationId,requestId){
  const [rows]=await pool.execute("SELECT event_json FROM sync_outbox WHERE origin_installation_id=? AND JSON_UNQUOTE(JSON_EXTRACT(event_json,'$.type'))='pos.checkout.recorded' AND JSON_UNQUOTE(JSON_EXTRACT(event_json,'$.payload.invoice.checkout_request_id'))=?",[installationId,requestId]);
  assert.equal(rows.length,1,'Exactly one outgoing checkout must be captured.');
  return typeof rows[0].event_json==='string'?JSON.parse(rows[0].event_json):rows[0].event_json;
}
async function invoiceCount(pool,requestId){const [[row]]=await pool.execute('SELECT COUNT(*) AS n FROM invoices WHERE checkout_request_id=?',[requestId]);return Number(row.n);}
async function stock(pool,barcode){const [[row]]=await pool.execute('SELECT stock_qty FROM products WHERE barcode=?',[barcode]);assert.ok(row);return Math.round(Number(row.stock_qty)*100);}
async function lostReplyCall(base,route,token,body,headers={}){
  // Commit at the real receiver and then deliberately close the proxy socket
  // before any acknowledgement reaches the caller.
  let response,forwardFailure;
  const proxy=http.createServer(async(req,res)=>{
    req.resume();
    try{
      response=await request(base,route,token,body,headers);
      assert.equal(response.status,200);
    }catch(error){forwardFailure=error;}
    res.destroy();
  });
  await new Promise(resolve=>proxy.listen(0,'127.0.0.1',resolve));
  try{
    await assert.rejects(fetch('http://127.0.0.1:'+proxy.address().port,{method:'POST',body:'drop reply',signal:AbortSignal.timeout(20000)}));
    if(forwardFailure)throw forwardFailure;
    assert.ok(response,'The real endpoint must finish before its reply is lost.');
    return response;
  }finally{proxy.closeAllConnections();await new Promise(resolve=>proxy.close(resolve));}
}
async function lostReplyDelivery(base,token,baselineId,event){const response=await lostReplyCall(base,'sync/events',token,event,{'X-Badizo-Baseline':baselineId});assert.equal(response.data.committed,true);}
async function runRecoveryFailureAcceptance({localUrl,cloudUrl,ownerToken,cloudSyncToken,baselineId,localPool,cloudPool,localInstallationId,barcode,salePrice}){
  assert.equal(process.env.DB_NAME,'badizo_cloud_validation','Use the isolated validation launcher environment.');
  endpoint(localUrl,'ready');endpoint(cloudUrl,'ready');
  assert.equal(new URL(localUrl).port,'5003');assert.equal(new URL(cloudUrl).port,'5004');
  const pools=[localPool,cloudPool],urls=[localUrl,cloudUrl];
  for(let index=0;index<2;index++){
    const pool=pools[index];
    const [[row]]=await pool.query('SELECT DATABASE() AS name');
    assert.match(row.name,/^badizo_recovery_[a-z0-9]+$/,'Production and development databases are excluded.');
    const [[enrollment]]=await pool.execute('SELECT installation_id,activation_id,baseline_id FROM sync_enrollment WHERE singleton=1');
    const ready=await request(urls[index],'ready',ownerToken);
    assert.equal(ready.status,200);assert.equal(ready.data.ok,true);assert.equal(ready.data.sync?.ready,true);
    assert.equal(ready.data.sync.installationId,enrollment.installation_id);assert.equal(ready.data.sync.baselineId,baselineId);
    assert.equal(ready.data.recovery?.activationId,enrollment.activation_id);assert.equal(enrollment.baseline_id,baselineId);
    assert.match(enrollment.installation_id,index===0?/^local-[a-f0-9-]{36}$/:/^cloud-[a-f0-9-]{36}$/,'Use fresh isolated drill installation identities.');
    if(index===0)assert.equal(enrollment.installation_id,localInstallationId);
  }
  assert.match(barcode,/^(ENROLLED|FAILURE)[A-Z0-9_-]+$/,'Use a synthetic acceptance product.');
  assert.ok(Number.isInteger(salePrice)&&salePrice>0&&salePrice<=100,'Use an ordinary low-value synthetic product.');
  const run=crypto.randomUUID(),phone='9'+String(crypto.randomInt(100000000,999999999));
  const payload={checkout_request_id:crypto.randomUUID(),counter_no:1,customer_name:'ISOLATED ACCEPTANCE '+run,customer_phone:phone,items:[{barcode,product_name:'ISOLATED ACCEPTANCE PRODUCT',quantity:1,sale_price:salePrice,gst_percent:0}],sub_total:salePrice,gst_total:0,grand_total:salePrice,payment_mode:'Cash',cash_received:salePrice,change_returned:0,billing_tier:'RETAIL',tax_type:'LOCAL'};
  const sourceBefore=await stock(localPool,barcode),targetBefore=await stock(cloudPool,barcode);
  const [[customerBefore]]=await cloudPool.execute('SELECT total_spent,visit_count FROM customers WHERE phone=?',[phone]);
  const denied=await request(cloudUrl,'billing/checkout',ownerToken,{...payload,checkout_request_id:crypto.randomUUID()});
  assert.equal(denied.status,409,'Cloud standby must reject billing even with a valid owner token.');
  const committed=await lostReplyCall(localUrl,'billing/checkout',ownerToken,payload);assert.equal(committed.data.success,true);
  const retry=await request(localUrl,'billing/checkout',ownerToken,payload);assert.equal(retry.status,200);assert.equal(retry.data.invoice_no,committed.data.invoice_no);
  for(const altered of [
    {...payload,customer_name:'DIFFERENT CUSTOMER'},
    {...payload,customer_phone:'8000000000'},
    {...payload,items:[{...payload.items[0],product_name:'DIFFERENT INTENT SAME TOTAL'}]},
    {...payload,payment_mode:'Card',cash_received:0,change_returned:0}
  ])assert.equal((await request(localUrl,'billing/checkout',ownerToken,altered)).status,409,'A reused request ID must reject changed sale intent, even when totals match.');
  assert.equal(await invoiceCount(localPool,payload.checkout_request_id),1);
  assert.equal(await stock(localPool,barcode),sourceBefore-100);
  const event=await committedEvent(localPool,localInstallationId,payload.checkout_request_id);
  await lostReplyDelivery(cloudUrl,cloudSyncToken,baselineId,event);
  const duplicate=await request(cloudUrl,'sync/events',cloudSyncToken,event,{'X-Badizo-Baseline':baselineId});
  assert.equal(duplicate.status,200);assert.equal(duplicate.data.duplicate,true);
  assert.equal(await invoiceCount(cloudPool,payload.checkout_request_id),1);
  assert.equal(await stock(cloudPool,barcode),targetBefore-100,'A lost acknowledgement must not deduct stock twice.');
  const [[received]]=await cloudPool.execute('SELECT customer_name,customer_phone FROM invoices WHERE checkout_request_id=?',[payload.checkout_request_id]);
  assert.equal(received.customer_name,payload.customer_name);assert.equal(received.customer_phone,payload.customer_phone);
  const [[customerAfter]]=await cloudPool.execute('SELECT total_spent,visit_count FROM customers WHERE phone=?',[phone]);
  assert.equal(Number(customerAfter.visit_count),Number(customerBefore?.visit_count||0)+1,'Duplicate receipt must not add a second customer visit.');
  assert.equal(Math.round(Number(customerAfter.total_spent)*100),Math.round(Number(customerBefore?.total_spent||0)*100)+salePrice*100);
  const [[archive]]=await cloudPool.execute('SELECT COUNT(*) AS n FROM sync_outbox WHERE event_id=? AND origin_installation_id=? AND acknowledged_at IS NOT NULL',[event.eventId,localInstallationId]);
  assert.equal(Number(archive.n),1,'The exact peer event must be retained once with its committed receipt.');
  const tampered=structuredClone(event);tampered.payload.invoice.customer_name='TAMPERED';
  assert.equal((await request(cloudUrl,'sync/events',cloudSyncToken,tampered,{'X-Badizo-Baseline':baselineId})).status,409);
  assert.equal(await stock(cloudPool,barcode),targetBefore-100);
  const racingId=crypto.randomUUID();
  const a={...payload,checkout_request_id:racingId,customer_name:'RACING INTENT A '+run};
  const b={...payload,checkout_request_id:racingId,customer_name:'RACING INTENT B '+run};
  const results=await Promise.all([request(localUrl,'billing/checkout',ownerToken,a),request(localUrl,'billing/checkout',ownerToken,b)]);
  assert.deepEqual(results.map(row=>row.status).sort(),[200,409],'Concurrent different payloads must not both receive success.');
  assert.equal(await invoiceCount(localPool,racingId),1);assert.equal(await stock(localPool,barcode),sourceBefore-200);
  const raceEvent=await committedEvent(localPool,localInstallationId,racingId);
  const delivered=await request(cloudUrl,'sync/events',cloudSyncToken,raceEvent,{'X-Badizo-Baseline':baselineId});assert.equal(delivered.status,200);
  assert.equal(await stock(cloudPool,barcode),targetBefore-200);
  return {realCheckoutRetry:true,lostCheckoutAcknowledgement:true,changedIntentRejected:true,concurrentIntentCollisionRejected:true,lostReceiverAcknowledgement:true,duplicateStockPreserved:true,duplicateCustomerEffectsPrevented:true,receivedRecoveryEvidenceRetained:true,customerNameAndPhonePreserved:true,standbyBillingRejected:true,alteredEnvelopeRejected:true,productionModified:false};
}
async function main(){
  const fs=require('node:fs/promises'),mysql=require('mysql2/promise');
  assert.equal(process.env.BADIZO_ACCEPTANCE_CONFIRMATION,'ISOLATED RECOVERY FAILURE DRILL');
  const config=JSON.parse(await fs.readFile(process.argv[2],'utf8'));
  for(const db of [config.localDatabase,config.cloudDatabase])assert.ok(['localhost','127.0.0.1','::1'].includes(db.host)&&/^badizo_recovery_[a-z0-9]+$/.test(db.database));
  assert.notEqual(config.localDatabase.database,config.cloudDatabase.database);
  const localPool=mysql.createPool({...config.localDatabase,connectionLimit:3}),cloudPool=mysql.createPool({...config.cloudDatabase,connectionLimit:3});
  try{console.log(JSON.stringify(await runRecoveryFailureAcceptance({...config,localPool,cloudPool})));}
  finally{await Promise.all([localPool.end(),cloudPool.end()]);}
}
module.exports={runRecoveryFailureAcceptance};
if(require.main===module)main().catch(error=>{console.error('Recovery failure acceptance failed: '+error.message);process.exitCode=1;});
