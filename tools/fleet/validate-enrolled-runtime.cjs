const fs=require('node:fs/promises'),path=require('node:path'),https=require('node:https'),http=require('node:http'),crypto=require('node:crypto'),assert=require('node:assert/strict'),{spawn}=require('node:child_process'),mysql=require('mysql2/promise'),jwt=require('jsonwebtoken');
const {atomic,json}=require('../../backend/services/recoveryControlFiles');
const {createRecoverySupervisor}=require('../../backend/services/recoverySupervisor');
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function main(){
  assert.equal(process.env.DB_NAME,'badizo_cloud_validation');
  const [localFile,cloudFile,keyFile,certFile]=process.argv.slice(2);
  const configs=await Promise.all([localFile,cloudFile].map(json));assert.notEqual(configs[0].database,configs[1].database);
  for(const config of configs){assert.match(config.database,/^badizo_recovery_[a-z0-9]+$/);assert.ok(['localhost','127.0.0.1'].includes(config.host));}
  const pools=configs.map(c=>mysql.createPool({host:c.host,user:c.user,password:c.password,database:c.database,multipleStatements:true,connectionLimit:4}));
  const root=await fs.mkdtemp('/var/lib/badizo/enrolled-validation-');
  const run=crypto.randomUUID(),baselineId=crypto.createHash('sha256').update('isolated-enrollment-'+run).digest('hex');
  const ids=['local-'+run,'cloud-'+run],tokens=[crypto.randomBytes(32).toString('hex'),crypto.randomBytes(32).toString('hex')],bindings=[],enrollments=[],children=[];
  let proxy,dropActivationReply=false;const supervisorTimers=[],supervisorWork=[null,null],supervisorErrors=[];
  const ownerHeaders={'Content-Type':'application/json',Authorization:'Bearer '+jwt.sign({role:'SERVER',username:'isolated-enrollment-owner'},process.env.JWT_SECRET)};
  async function request(index,route,body){
    const response=await fetch('http://127.0.0.1:'+(5003+index)+'/api/'+route,{method:body===undefined?'GET':'POST',headers:ownerHeaders,...(body===undefined?{}:{body:JSON.stringify(body)})});
    const data=await response.json();if(!response.ok)throw Error('Owner API '+route+' failed with '+response.status);return data;
  }
  async function until(operation,label,timeout=75000){const end=Date.now()+timeout;while(Date.now()<end){try{if(await operation())return;}catch{}await sleep(300);}throw Error('Timed out: '+label);}
  async function start(index){
    const child=spawn(process.execPath,['server.js'],{cwd:process.cwd(),env:{...process.env,PORT:String(5003+index),HOST:'127.0.0.1',BADIZO_LOOPBACK_ONLY:'true',BADIZO_DISABLE_3000_REDIRECT:'true',BADIZO_DISABLE_SCHEDULED_JOBS:'true',BADIZO_SMS_ENABLED:'false',BADIZO_WHATSAPP_ENABLED:'false',BADIZO_SHOP_ID:'HFM001',BADIZO_NODE_ROLE:index?'cloud-standby':'local-server',BADIZO_RUNTIME_BINDING:path.join(root,index+'-binding.json'),BADIZO_SYNC_ENROLLMENT_CONFIG:path.join(root,index+'-enrollment.json'),NODE_EXTRA_CA_CERTS:certFile,BADIZO_RECOVERY_REVIEW_ENABLED:'false',BADIZO_RECOVERY_APPLY_ENABLED:'false',BADIZO_RECOVERY_CONTROL_CONFIG:path.join(root,index+'-control.json'),BADIZO_STAGED_RESTORE_ENABLED:'false'},stdio:'ignore'});
    children[index]=child;
    await until(async()=>{const response=await fetch('http://127.0.0.1:'+(5003+index)+'/api/ready');const ready=await response.json();return ready.ok&&ready.sync?.ready;},'enrolled POS startup',15000);
  }
  async function stop(index){const child=children[index];if(child&&child.exitCode===null&&child.signalCode===null){const closed=new Promise(resolve=>child.once('exit',resolve));child.kill('SIGTERM');await closed;}children[index]=null;}
  try{
    const migrations=['outbox','inbox','worker','invoice-map','invoice-batches','stock-adjustment','supplier-payments','recovery-applications','enrollment','checkout-requests'];
    for(const pool of pools)for(const name of migrations){const sql=(await fs.readFile(path.resolve(__dirname,'../../database/migrations/optional-sync-'+name+'.sql'),'utf8')).replace(/CREATE TABLE (?!IF NOT EXISTS)/g,'CREATE TABLE IF NOT EXISTS ');await pool.query(sql);}
    const {invoiceSnapshot}=require('../../backend/services/invoiceOriginIdentity');
    const {canonical}=require('../../backend/services/syncEventProtocol');
    const [candidates]=await pools[0].execute("SELECT DISTINCT invoice_no FROM invoice_items WHERE quantity>=2 AND gst_percent=0 AND returned_qty=0 AND is_free_bonus=0 AND free_offer_id IS NULL ORDER BY invoice_no LIMIT 1000");
    let historical;
    for(const candidate of candidates){
      const snapshots=await Promise.all(pools.map(pool=>invoiceSnapshot(pool,candidate.invoice_no)));
      const s=snapshots[0];
      if(s.invoice.invoice_status!=='PAID'||Number(s.invoice.exchange_total)!==0||s.invoice.exchange_items_json!==null||canonical(s)!==canonical(snapshots[1])||s.items.length!==1||Number(s.items[0].quantity)<2||s.loyaltyTransactions.length||s.batchAllocations.length||s.items.some(item=>Number(item.returned_qty)!==0||Number(item.is_free_bonus)!==0||item.free_offer_id!==null))continue;
      const [mapped]=await pools[0].execute('SELECT target_invoice_no FROM sync_invoice_map WHERE target_invoice_no=?',[candidate.invoice_no]);if(mapped.length)continue;
      historical=s;break;
    }
    assert.ok(historical,'common backup must contain an eligible untouched historical invoice');
    proxy=https.createServer({key:await fs.readFile(keyFile),cert:await fs.readFile(certFile)},(req,res)=>{
      let body='';req.on('data',chunk=>{if(body.length<4096)body+=chunk.toString();});
      const forward=http.request({host:'127.0.0.1',port:5004,path:req.url,method:req.method,headers:req.headers},upstream=>{
        if(dropActivationReply&&req.url==='/api/sync/handoff'&&body.includes('"activate"')){dropActivationReply=false;upstream.resume();res.destroy();return;}
        res.writeHead(upstream.statusCode,upstream.headers);upstream.pipe(res);
      });
      forward.on('error',()=>{res.writeHead(502);res.end();});req.pipe(forward);
    }).listen(0,'127.0.0.1');await new Promise(resolve=>proxy.once('listening',resolve));
    const baseUrl='https://127.0.0.1:'+proxy.address().port+'/api/sync';
    for(let i=0;i<2;i++){
      const c=configs[i],activationId=crypto.randomUUID();
      const binding={schemaVersion:1,shopId:'HFM001',activationId,generation:0,phase:'active',billingMode:i?'standby':'active',database:{host:c.host,user:c.user,password:c.password,database:c.database}};bindings.push(binding);
      const enrollment={schemaVersion:1,contractVersion:1,shopId:'HFM001',installationId:ids[i],peerInstallationId:ids[1-i],nodeRole:i?'cloud-standby':'local-server',databaseName:c.database,baselineId,activationId,settingsDirectory:path.join(root,i+'-settings'),reviewDirectory:path.join(root,i+'-reviews'),incomingToken:tokens[i],peer:i?null:{baseUrl,token:tokens[1]}};enrollments.push(enrollment);
      await atomic(path.join(root,i+'-binding.json'),binding);await atomic(path.join(root,i+'-enrollment.json'),enrollment);
      const control={shopId:'HFM001',nodeRole:i?'cloud-standby':'local-server',directory:path.join(root,i+'-control'),bindingPath:path.join(root,i+'-binding.json'),enrollmentConfigPath:path.join(root,i+'-enrollment.json'),restoreConfigPath:path.join(root,'unused-restore.json'),restoreJobDirectory:path.join(root,'unused-jobs'),readyUrl:'http://127.0.0.1:'+(5003+i)+'/api/ready',healthTimeoutMs:15000};
      await atomic(path.join(root,i+'-control.json'),control);
      await atomic(path.join(control.directory,'heartbeat.json'),{shopId:'HFM001',at:new Date().toISOString()});
      const supervisor=createRecoverySupervisor(control,{fetchReady:async()=>{
        // Deliberately lengthen the drain window: peer status polling must
        // remain available while mutations are correctly blocked.
        if(i===1)await sleep(350);
        const response=await fetch(control.readyUrl,{signal:AbortSignal.timeout(2000)});if(!response.ok)throw Error('POS not ready');return response.json();
      }});
      supervisorTimers.push(setInterval(()=>{
        if(supervisorWork[i])return;
        supervisorWork[i]=(async()=>{await atomic(path.join(control.directory,'heartbeat.json'),{shopId:'HFM001',at:new Date().toISOString()});await supervisor.tick();})().catch(error=>supervisorErrors.push(error.message)).finally(()=>{supervisorWork[i]=null;});
      },250));
      await pools[i].execute('INSERT INTO sync_enrollment (singleton,shop_id,installation_id,peer_installation_id,baseline_id,activation_id,contract_version,enabled) VALUES (1,?,?,?,?,?,1,1) ON DUPLICATE KEY UPDATE shop_id=VALUES(shop_id),installation_id=VALUES(installation_id),peer_installation_id=VALUES(peer_installation_id),baseline_id=VALUES(baseline_id),activation_id=VALUES(activation_id),contract_version=1,enabled=1',['HFM001',ids[i],ids[1-i],baselineId,activationId]);
    }
    await start(1);await start(0);
    const wrong=await fetch('http://127.0.0.1:5004/api/sync/status',{headers:{Authorization:'Bearer '+tokens[1],'X-Badizo-Baseline':'0'.repeat(64)}});assert.equal(wrong.status,409);
    const unauthorized=await fetch('http://127.0.0.1:5004/api/sync/events',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});assert.equal(unauthorized.status,401);
    const barcode='ENROLLED'+crypto.randomBytes(8).toString('hex').toUpperCase();
    const product={barcode,original_barcode:barcode,product_code:barcode,code_mode:'MANUAL',product_name:'ENROLLED TEST '+run,hsn_code:'TEST',gst_percent:0,unit_type:'PCS',purchase_unit_type:'PCS',purchase_unit_size:1,mrp:20,purchase_price:5,sale_price:10,stock_qty:10,min_stock_alert:1};
    await request(0,'products/save',product);await request(0,'cloud-sync/run',{});
    await until(async()=>{const [[row]]=await pools[1].execute('SELECT sale_price FROM products WHERE barcode=?',[barcode]);return Number(row?.sale_price)===10;},'local product reaches cloud standby');
    assert.equal((await request(0,'cloud-sync/settings')).service.ready,true);
    await atomic(path.join(root,'1-binding.json'),{...bindings[1],billingMode:'active'});
    await request(1,'products/save',{...product,sale_price:12});await request(0,'products/save',{...product,sale_price:11});await request(0,'cloud-sync/run',{});
    let review;
    await until(async()=>{const result=await request(0,'recovery-review');if(!result.reviews.length)return false;review=await request(0,'recovery-review/'+result.reviews[0].id);return review.plan.entries.some(entry=>entry.recordId===barcode);},'automatic conflict review');
    const selected=await request(0,'recovery-review/'+review.plan.id+'/decisions',{expectedRevision:review.revision,side:'local',conflictIds:review.plan.entries.filter(entry=>entry.state==='conflict').map(entry=>entry.id)});
    await request(0,'recovery-review/'+review.plan.id+'/apply',{expectedRevision:selected.revision,expectedHeadHash:selected.headHash,confirmation:'APPLY REVIEWED PRODUCT CHOICES'});
    await request(0,'cloud-sync/run',{});
    await until(async()=>{
      const [[row]]=await pools[1].execute('SELECT sale_price FROM products WHERE barcode=?',[barcode]);
      const pending=await Promise.all(pools.map((pool,i)=>pool.execute('SELECT COUNT(*) AS n FROM sync_outbox WHERE origin_installation_id=? AND acknowledged_at IS NULL',[ids[i]])));
      return Number(row.sale_price)===11&&pending.every(result=>Number(result[0][0].n)===0);
    },'both queues drain through actual scheduled runtime');
    await stop(0);await start(0);assert.equal((await request(0,'cloud-sync/settings')).service.ready,true);
    async function handoff(kind,expected='complete'){
      const state=await request(0,'recovery-control');
      const started=await request(0,'recovery-control',{kind,expectedGeneration:state.generation,confirmation:kind==='use-cloud'?'SYNC AND USE CLOUD':'SYNC AND USE LOCAL'});
      let outcome;
      await until(async()=>{const current=await request(0,'recovery-control');if(current.operation?.id!==started.id)return false;outcome=current.operation;return [expected,'failed','rolled-back'].includes(outcome.state);},kind,25000);
      assert.equal(outcome.state,expected,kind+': '+(outcome.failedStage||'')+' / '+(outcome.failureCode||''));
      console.log('Validated handoff: '+kind+' / '+expected);
    }
    await handoff('use-cloud');
    assert.equal((await request(0,'recovery-control')).billingMode,'standby');assert.equal((await request(1,'recovery-control')).billingMode,'active');
    const denied=await fetch('http://127.0.0.1:5003/api/products/save',{method:'POST',headers:ownerHeaders,body:JSON.stringify({...product,sale_price:99})});assert.equal(denied.status,409);
    await request(1,'products/save',{...product,sale_price:12});
    const emergencyBill=await request(1,'billing/checkout',{checkout_request_id:crypto.randomUUID(),counter_no:1,customer_name:'ISOLATED HANDOFF CUSTOMER',customer_phone:'',items:[{barcode,product_name:product.product_name,quantity:1,sale_price:12,gst_percent:0}],sub_total:12,gst_total:0,grand_total:12,payment_mode:'Cash',cash_received:12,change_returned:0,billing_tier:'RETAIL',tax_type:'LOCAL'});
    await handoff('use-local');
    assert.equal((await request(0,'recovery-control')).billingMode,'active');assert.equal((await request(1,'recovery-control')).billingMode,'standby');
    const [[returnedProduct]]=await pools[0].execute('SELECT sale_price FROM products WHERE barcode=?',[barcode]);assert.equal(Number(returnedProduct.sale_price),12);assert.deepEqual(supervisorErrors,[]);
    const [[recoveredBill]]=await pools[0].execute('SELECT customer_name,grand_total FROM invoices WHERE invoice_no=?',[emergencyBill.invoice_no]);assert.equal(recoveredBill.customer_name,'ISOLATED HANDOFF CUSTOMER');assert.equal(Number(recoveredBill.grand_total),12);
    const [[returnedLine]]=await pools[0].execute('SELECT id FROM invoice_items WHERE invoice_no=?',[emergencyBill.invoice_no]);
    await request(0,'billing/return',{invoice_no:emergencyBill.invoice_no,reason:'ISOLATED CROSS-SERVER RETURN',refund_mode:'Cash',items:[{invoice_item_id:returnedLine.id,quantity:1}]});
    await handoff('use-cloud');
    const [[cloudReturn]]=await pools[1].execute('SELECT invoice_status FROM invoices WHERE invoice_no=?',[emergencyBill.invoice_no]);assert.equal(cloudReturn.invoice_status,'RETURNED');
    const [[cloudStock]]=await pools[1].execute('SELECT stock_qty FROM products WHERE barcode=?',[barcode]);assert.equal(Number(cloudStock.stock_qty),10);
    await handoff('use-local');
    const voidBill=await request(0,'billing/checkout',{checkout_request_id:crypto.randomUUID(),counter_no:1,customer_name:'ISOLATED VOID CUSTOMER',customer_phone:'',items:[{barcode,product_name:product.product_name,quantity:1,sale_price:12,gst_percent:0}],sub_total:12,gst_total:0,grand_total:12,payment_mode:'Cash',cash_received:12,change_returned:0,billing_tier:'RETAIL',tax_type:'LOCAL'});
    await handoff('use-cloud');
    await request(1,'billing/invoice/void',{invoice_no:voidBill.invoice_no,reason:'ISOLATED CROSS-SERVER CANCELLATION'});
    await handoff('use-local');
    const [[voided]]=await pools[0].execute('SELECT invoice_status FROM invoices WHERE invoice_no=?',[voidBill.invoice_no]);assert.equal(voided.invoice_status,'CANCELLED');
    // Existing bills in the common backup have no checkout event. Adopt only
    // complete identical snapshots, then exercise returns on both servers.
    await request(0,'billing/return',{invoice_no:historical.invoice.invoice_no,reason:'ISOLATED HISTORICAL RETURN',refund_mode:'Cash',items:[{invoice_item_id:historical.items[0].id,quantity:1}]});
    await handoff('use-cloud');
    const [[historicalCloud]]=await pools[1].execute('SELECT invoice_status FROM invoices WHERE invoice_no=?',[historical.invoice.invoice_no]);assert.equal(historicalCloud.invoice_status,'PARTIALLY_RETURNED');
    await request(1,'billing/return',{invoice_no:historical.invoice.invoice_no,reason:'ISOLATED REMAINING RETURN',refund_mode:'Cash',items:[{invoice_item_id:historical.items[0].id,quantity:Number(historical.items[0].quantity)-1}]});
    await handoff('use-local');
    const [[historicalLocal]]=await pools[0].execute('SELECT invoice_status FROM invoices WHERE invoice_no=?',[historical.invoice.invoice_no]);assert.equal(historicalLocal.invoice_status,'RETURNED');
    dropActivationReply=true;await handoff('use-cloud','failed');
    await until(async()=> (await request(1,'recovery-control')).billingMode==='active','cloud commits after lost response');
    assert.equal((await request(0,'recovery-control')).billingMode,'standby');assert.equal(dropActivationReply,false);
    await handoff('use-local');assert.equal((await request(1,'recovery-control')).billingMode,'standby');
    const blockedPayment={eventId:crypto.randomUUID(),shopId:'HFM001',originInstallationId:ids[1],schemaVersion:1,type:'pos.supplier-payment.recorded',payload:{payment:{id:1,inward_no:'MISSING-'+run,supplier_name:'ISOLATED MISSING SUPPLIER',supplier_gstin:'',amount:'10.00'},before:{grand_total:'100.00',paid_amount:'0.00',due_amount:'100.00'},after:{grand_total:'100.00',paid_amount:'10.00',due_amount:'90.00'}}};
    const blockedResponse=await fetch('http://127.0.0.1:5003/api/sync/events',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+tokens[0],'X-Badizo-Baseline':baselineId},body:JSON.stringify(blockedPayment)});assert.equal(blockedResponse.status,409);
    const caseList=await request(0,'recovery-cases'),financialCase=caseList.cases.find(item=>item.eventId===blockedPayment.eventId);assert.ok(financialCase);
    const detailedCase=await request(0,'recovery-cases/'+financialCase.id);assert.equal(detailedCase.comparison.sourceAfter.paid_amount,'10.00');
    const retriedCase=await request(0,'recovery-cases/'+financialCase.id+'/retry',{expectedRevision:0,note:'Isolated validation: purchase is deliberately missing; retain the payment.',confirmation:'RETRY WITHOUT DISCARDING RECORDS'});assert.equal(retriedCase.status,'needs-correction');assert.equal(retriedCase.history[0].outcome,'still-blocked');
    const [[blockedReceipt]]=await pools[0].execute('SELECT COUNT(*) AS n FROM sync_inbox WHERE event_id=?',[blockedPayment.eventId]);assert.equal(Number(blockedReceipt.n),0);
    const failureAcceptance=await require('./validate-recovery-failures.cjs').runRecoveryFailureAcceptance({localUrl:'http://127.0.0.1:5003',cloudUrl:'http://127.0.0.1:5004',ownerToken:ownerHeaders.Authorization.slice(7),cloudSyncToken:tokens[1],baselineId,localPool:pools[0],cloudPool:pools[1],localInstallationId:ids[0],barcode,salePrice:12});
    assert.equal(failureAcceptance.productionModified,false);
    await handoff('use-cloud');await handoff('use-local');
    const financialAcceptance=await require('./validate-financial-corrections.cjs').runFinancialCorrectionDrill({pools,request,identities:ids.map((id,index)=>({shopId:'HFM001',localInstallationId:id,peerInstallationId:ids[1-index]})),deliver:async(index,event)=>{
      const response=await fetch('http://127.0.0.1:'+(5003+index)+'/api/sync/events',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+tokens[index],'X-Badizo-Baseline':baselineId},body:JSON.stringify(event)});
      return {status:response.status,body:await response.json()};
    }});
    assert.equal(financialAcceptance.duplicateSupplierPaymentMatched,true);assert.equal(financialAcceptance.twoSidedAuditDeltasConverged,true);
    await handoff('use-cloud');await handoff('use-local');
    // A new restored binding keeps billing available but must not silently
    // reuse the previous installation's event mappings.
    await stop(0);await atomic(path.join(root,'0-binding.json'),{...bindings[0],activationId:crypto.randomUUID(),generation:1});
    const child=spawn(process.execPath,['server.js'],{cwd:process.cwd(),env:{...process.env,PORT:'5003',HOST:'127.0.0.1',BADIZO_LOOPBACK_ONLY:'true',BADIZO_DISABLE_3000_REDIRECT:'true',BADIZO_DISABLE_SCHEDULED_JOBS:'true',BADIZO_SMS_ENABLED:'false',BADIZO_WHATSAPP_ENABLED:'false',BADIZO_SHOP_ID:'HFM001',BADIZO_NODE_ROLE:'local-server',BADIZO_RUNTIME_BINDING:path.join(root,'0-binding.json'),BADIZO_SYNC_ENROLLMENT_CONFIG:path.join(root,'0-enrollment.json'),BADIZO_RECOVERY_REVIEW_ENABLED:'false',BADIZO_RECOVERY_APPLY_ENABLED:'false',BADIZO_RECOVERY_CONTROL_CONFIG:'',BADIZO_STAGED_RESTORE_ENABLED:'false'},stdio:'ignore'});children[0]=child;
    await until(async()=>{const response=await fetch('http://127.0.0.1:5003/api/ready');const value=await response.json();return value.ok&&value.sync?.reason==='restored-database-requires-enrollment';},'restored local startup',15000);
    await request(0,'products/save',{...product,sale_price:13});assert.equal((await request(0,'cloud-sync/settings')).service.ready,false);
    console.log(JSON.stringify({twoRealPosProcesses:true,authenticatedHttpsSync:true,normalCloudHandoff:true,returnToLocalIncludesCloudChanges:true,crossServerReturn:true,crossServerCancellation:true,historicalBackupInvoiceReturns:true,lostActivationReplyNeverEnablesLocal:true,retryAfterUnknownOutcome:true,standbyReceivesUpdates:true,manualButtonRunsWorker:true,conflictsAppearInOwnerApi:true,ownerResolutionDrainsBothQueues:true,restartPreservesEnrollment:true,restoreEpochBlocksStaleMappings:true,restoredLocalBillingAvailable:true,checkoutFailureAcceptance:failureAcceptance,financialAcceptance,productionModified:false}));
  }finally{supervisorTimers.forEach(clearInterval);await Promise.all(supervisorWork.filter(Boolean));await stop(0);await stop(1);if(proxy)await new Promise(resolve=>proxy.close(resolve));await Promise.all(pools.map(pool=>pool.end()));}
}
main().catch(error=>{console.error('Enrolled runtime drill failed: '+error.message);process.exitCode=1;});
