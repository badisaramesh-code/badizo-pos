const fs=require('node:fs/promises'),path=require('node:path'),https=require('node:https'),http=require('node:http'),crypto=require('node:crypto'),assert=require('node:assert/strict'),{spawn}=require('node:child_process'),mysql=require('mysql2/promise'),jwt=require('jsonwebtoken');
const {atomic,json}=require('../../backend/services/recoveryControlFiles');
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
  let proxy;
  const ownerHeaders={'Content-Type':'application/json',Authorization:'Bearer '+jwt.sign({role:'SERVER',username:'isolated-enrollment-owner'},process.env.JWT_SECRET)};
  async function request(index,route,body){
    const response=await fetch('http://127.0.0.1:'+(5003+index)+'/api/'+route,{method:body===undefined?'GET':'POST',headers:ownerHeaders,...(body===undefined?{}:{body:JSON.stringify(body)})});
    const data=await response.json();if(!response.ok)throw Error('Owner API '+route+' failed with '+response.status);return data;
  }
  async function until(operation,label,timeout=75000){const end=Date.now()+timeout;while(Date.now()<end){try{if(await operation())return;}catch{}await sleep(300);}throw Error('Timed out: '+label);}
  async function start(index){
    const child=spawn(process.execPath,['server.js'],{cwd:process.cwd(),env:{...process.env,PORT:String(5003+index),HOST:'127.0.0.1',BADIZO_LOOPBACK_ONLY:'true',BADIZO_DISABLE_3000_REDIRECT:'true',BADIZO_DISABLE_SCHEDULED_JOBS:'true',BADIZO_SMS_ENABLED:'false',BADIZO_WHATSAPP_ENABLED:'false',BADIZO_SHOP_ID:'HFM001',BADIZO_NODE_ROLE:index?'cloud-standby':'local-server',BADIZO_RUNTIME_BINDING:path.join(root,index+'-binding.json'),BADIZO_SYNC_ENROLLMENT_CONFIG:path.join(root,index+'-enrollment.json'),NODE_EXTRA_CA_CERTS:certFile,BADIZO_RECOVERY_REVIEW_ENABLED:'false',BADIZO_RECOVERY_APPLY_ENABLED:'false',BADIZO_RECOVERY_CONTROL_CONFIG:'',BADIZO_STAGED_RESTORE_ENABLED:'false'},stdio:'ignore'});
    children[index]=child;
    await until(async()=>{const response=await fetch('http://127.0.0.1:'+(5003+index)+'/api/ready');const ready=await response.json();return ready.ok&&ready.sync?.ready;},'enrolled POS startup',15000);
  }
  async function stop(index){const child=children[index];if(child&&child.exitCode===null&&child.signalCode===null){const closed=new Promise(resolve=>child.once('exit',resolve));child.kill('SIGTERM');await closed;}children[index]=null;}
  try{
    const migrations=['outbox','inbox','worker','invoice-map','invoice-batches','stock-adjustment','supplier-payments','recovery-applications','enrollment'];
    for(const pool of pools)for(const name of migrations){const sql=(await fs.readFile(path.resolve(__dirname,'../../database/migrations/optional-sync-'+name+'.sql'),'utf8')).replace(/CREATE TABLE (?!IF NOT EXISTS)/g,'CREATE TABLE IF NOT EXISTS ');await pool.query(sql);}
    proxy=https.createServer({key:await fs.readFile(keyFile),cert:await fs.readFile(certFile)},(req,res)=>{
      const forward=http.request({host:'127.0.0.1',port:5004,path:req.url,method:req.method,headers:req.headers},upstream=>{res.writeHead(upstream.statusCode,upstream.headers);upstream.pipe(res);});
      forward.on('error',()=>{res.writeHead(502);res.end();});req.pipe(forward);
    }).listen(0,'127.0.0.1');await new Promise(resolve=>proxy.once('listening',resolve));
    const baseUrl='https://127.0.0.1:'+proxy.address().port+'/api/sync';
    for(let i=0;i<2;i++){
      const c=configs[i],activationId=crypto.randomUUID();
      const binding={schemaVersion:1,shopId:'HFM001',activationId,generation:0,phase:'active',billingMode:i?'standby':'active',database:{host:c.host,user:c.user,password:c.password,database:c.database}};bindings.push(binding);
      const enrollment={schemaVersion:1,contractVersion:1,shopId:'HFM001',installationId:ids[i],peerInstallationId:ids[1-i],nodeRole:i?'cloud-standby':'local-server',databaseName:c.database,baselineId,activationId,settingsDirectory:path.join(root,i+'-settings'),reviewDirectory:path.join(root,i+'-reviews'),incomingToken:tokens[i],peer:i?null:{baseUrl,token:tokens[1]}};enrollments.push(enrollment);
      await atomic(path.join(root,i+'-binding.json'),binding);await atomic(path.join(root,i+'-enrollment.json'),enrollment);
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
    // A new restored binding keeps billing available but must not silently
    // reuse the previous installation's event mappings.
    await stop(0);await atomic(path.join(root,'0-binding.json'),{...bindings[0],activationId:crypto.randomUUID(),generation:1});
    const child=spawn(process.execPath,['server.js'],{cwd:process.cwd(),env:{...process.env,PORT:'5003',HOST:'127.0.0.1',BADIZO_LOOPBACK_ONLY:'true',BADIZO_DISABLE_3000_REDIRECT:'true',BADIZO_DISABLE_SCHEDULED_JOBS:'true',BADIZO_SMS_ENABLED:'false',BADIZO_WHATSAPP_ENABLED:'false',BADIZO_SHOP_ID:'HFM001',BADIZO_NODE_ROLE:'local-server',BADIZO_RUNTIME_BINDING:path.join(root,'0-binding.json'),BADIZO_SYNC_ENROLLMENT_CONFIG:path.join(root,'0-enrollment.json'),BADIZO_RECOVERY_REVIEW_ENABLED:'false',BADIZO_RECOVERY_APPLY_ENABLED:'false',BADIZO_RECOVERY_CONTROL_CONFIG:'',BADIZO_STAGED_RESTORE_ENABLED:'false'},stdio:'ignore'});children[0]=child;
    await until(async()=>{const response=await fetch('http://127.0.0.1:5003/api/ready');const value=await response.json();return value.ok&&value.sync?.reason==='restored-database-requires-enrollment';},'restored local startup',15000);
    await request(0,'products/save',{...product,sale_price:13});assert.equal((await request(0,'cloud-sync/settings')).service.ready,false);
    console.log(JSON.stringify({twoRealPosProcesses:true,authenticatedHttpsSync:true,standbyReceivesUpdates:true,manualButtonRunsWorker:true,conflictsAppearInOwnerApi:true,ownerResolutionDrainsBothQueues:true,restartPreservesEnrollment:true,restoreEpochBlocksStaleMappings:true,restoredLocalBillingAvailable:true,productionModified:false}));
  }finally{await stop(0);await stop(1);if(proxy)await new Promise(resolve=>proxy.close(resolve));await Promise.all(pools.map(pool=>pool.end()));}
}
main().catch(error=>{console.error('Enrolled runtime drill failed: '+error.message);process.exitCode=1;});
