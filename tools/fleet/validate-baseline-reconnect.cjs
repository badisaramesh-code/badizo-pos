// Isolated acceptance only: two empty-schema source databases and two empty
// recovery targets, four separately scoped accounts, no production credentials.
const fs=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto'),assert=require('node:assert/strict'),http=require('node:http'),https=require('node:https'),{spawn}=require('node:child_process'),mysql=require('mysql2/promise'),jwt=require('jsonwebtoken');
const {atomic,json}=require('../../backend/services/recoveryControlFiles');
const {createRecoverySupervisor}=require('../../backend/services/recoverySupervisor');
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function main(){
  assert.equal(process.env.DB_NAME,'badizo_cloud_validation');
  const [fixtureDirectory,keyFile,certFile]=process.argv.slice(2);
  const configs=await Promise.all(['source-local','source-cloud','candidate-local','candidate-cloud'].map(name=>json(path.join(fixtureDirectory,name+'.json'))));
  assert.equal(new Set(configs.map(c=>c.database)).size,4);
  for(const c of configs){assert.match(c.database,/^badizo_recovery_pair[a-z0-9]+$/);assert.ok(['127.0.0.1','localhost'].includes(c.host));}
  const pools=configs.map(c=>mysql.createPool({host:c.host,user:c.user,password:c.password,database:c.database,multipleStatements:true,connectionLimit:4}));
  const root=await fs.mkdtemp('/var/lib/badizo/baseline-acceptance-'),children=[],controls=[],timers=[],work=[null,null],failures=[];
  const run=crypto.randomUUID(),oldBaseline=crypto.randomBytes(32).toString('hex'),syncTokens=[crypto.randomBytes(32).toString('hex'),crypto.randomBytes(32).toString('hex')],prepTokens=[crypto.randomBytes(32).toString('hex'),crypto.randomBytes(32).toString('hex')],baselineTokens=[crypto.randomBytes(32).toString('hex'),crypto.randomBytes(32).toString('hex')];
  let proxy,dropRelease=false;
  const ownerHeaders={'Content-Type':'application/json',Authorization:'Bearer '+jwt.sign({role:'SERVER',username:'isolated-recovery-owner'},process.env.JWT_SECRET)};
  async function until(operation,label,timeout=120000){const end=Date.now()+timeout;while(Date.now()<end){try{if(await operation())return;}catch{}await sleep(250);}throw Error('Timed out: '+label);}
  async function request(index,route,body){const response=await fetch('http://127.0.0.1:'+(5003+index)+'/api/'+route,{method:body===undefined?'GET':'POST',headers:ownerHeaders,...(body===undefined?{}:{body:JSON.stringify(body)})});const value=await response.json();if(!response.ok)throw Error('Owner '+route+' rejected '+response.status);return value;}
  async function stop(index){const child=children[index];if(child&&child.exitCode===null&&child.signalCode===null){const done=new Promise(resolve=>child.once('exit',resolve));child.kill('SIGTERM');await done;}children[index]=null;}
  async function start(index){
    children[index]=spawn(process.execPath,['server.js'],{cwd:process.cwd(),env:{...process.env,PORT:String(5003+index),HOST:'127.0.0.1',BADIZO_LOOPBACK_ONLY:'true',BADIZO_DISABLE_3000_REDIRECT:'true',BADIZO_DISABLE_SCHEDULED_JOBS:'true',BADIZO_SMS_ENABLED:'false',BADIZO_WHATSAPP_ENABLED:'false',BADIZO_SHOP_ID:'HFM001',BADIZO_NODE_ROLE:index?'cloud-standby':'local-server',BADIZO_RUNTIME_BINDING:controls[index].bindingPath,BADIZO_SYNC_ENROLLMENT_CONFIG:controls[index].enrollmentConfigPath,BADIZO_RECOVERY_CONTROL_CONFIG:path.join(root,index+'-control.json'),BADIZO_RECOVERY_REVIEW_ENABLED:'false',BADIZO_RECOVERY_APPLY_ENABLED:'false',BADIZO_STAGED_RESTORE_ENABLED:'false',NODE_EXTRA_CA_CERTS:certFile},stdio:'ignore'});
  }
  async function ready(index){const response=await fetch(controls[index].readyUrl);return response.json();}
  try{
    for(let i=0;i<4;i++){
      const [[row]]=await pools[i].query('SELECT COUNT(*) AS n FROM information_schema.tables WHERE table_schema=DATABASE()');
      if(i>=2)assert.equal(Number(row.n),0,'candidate must start empty');
      else{assert.ok(Number(row.n)>20);const [[count]]=await pools[i].query('SELECT COUNT(*) AS n FROM invoices');assert.equal(Number(count.n),0,'source fixture must contain no customer bills');}
    }
    const migrations=['outbox','inbox','worker','invoice-map','invoice-batches','stock-adjustment','supplier-payments','recovery-applications','enrollment','checkout-requests'];
    for(const pool of pools.slice(0,2))for(const name of migrations){const sql=(await fs.readFile(path.resolve(__dirname,'../../database/migrations/optional-sync-'+name+'.sql'),'utf8')).replace(/CREATE TABLE (?!IF NOT EXISTS)/g,'CREATE TABLE IF NOT EXISTS ');await pool.query(sql);}
    proxy=https.createServer({key:await fs.readFile(keyFile),cert:await fs.readFile(certFile)},(req,res)=>{
      let body='';req.on('data',chunk=>{if(body.length<4096)body+=chunk.toString();});
      const forward=http.request({host:'127.0.0.1',port:5004,path:req.url,method:req.method,headers:req.headers},upstream=>{
        if(dropRelease&&req.url==='/api/recovery-baseline'&&body.includes('"release"')){dropRelease=false;upstream.resume();res.destroy();return;}
        res.writeHead(upstream.statusCode,upstream.headers);upstream.pipe(res);
      });forward.on('error',()=>{res.writeHead(502);res.end();});req.pipe(forward);
    }).listen(0,'127.0.0.1');await new Promise(resolve=>proxy.once('listening',resolve));
    const cloudUrl='https://127.0.0.1:'+proxy.address().port;
    for(let i=0;i<2;i++){
      const directory=path.join(root,i+'-supervisor'),activationId=crypto.randomUUID();
      const c=configs[i],control={shopId:'HFM001',nodeRole:i?'cloud-standby':'local-server',directory,bindingPath:path.join(root,i+'-binding.json'),enrollmentConfigPath:path.join(root,i+'-enrollment.json'),baselinePlanPath:path.join(root,i+'-baseline.json'),preparationConfigPath:path.join(root,i+'-preparation.json'),restoreConfigPath:path.join(root,'unused-restore.json'),restoreJobDirectory:path.join(root,'unused-jobs'),readyUrl:'http://127.0.0.1:'+(5003+i)+'/api/ready',healthTimeoutMs:30000,baselineTimeoutMs:30000,start:{action:'start',side:i},stop:{action:'stop',side:i}};controls.push(control);
      await atomic(path.join(root,i+'-control.json'),control);
      await atomic(control.bindingPath,{schemaVersion:1,shopId:'HFM001',activationId,generation:0,phase:'active',billingMode:i?'active':'standby',database:{host:c.host,user:c.user,password:c.password,database:c.database}});
      const enrollment={schemaVersion:1,contractVersion:1,shopId:'HFM001',installationId:(i?'cloud-':'local-')+run,peerInstallationId:(i?'local-':'cloud-')+run,nodeRole:control.nodeRole,databaseName:c.database,baselineId:oldBaseline,activationId,settingsDirectory:path.join(root,i+'-settings'),reviewDirectory:path.join(root,i+'-reviews'),incomingToken:syncTokens[i],peer:i?null:{baseUrl:cloudUrl+'/api/sync',token:syncTokens[1]}};
      await atomic(control.enrollmentConfigPath,enrollment);
      await pools[i].execute('INSERT INTO sync_enrollment (singleton,shop_id,installation_id,peer_installation_id,baseline_id,activation_id,contract_version,enabled) VALUES (1,?,?,?,?,?,1,1)',['HFM001',enrollment.installationId,enrollment.peerInstallationId,oldBaseline,activationId]);
      const restorePath=path.join(root,i+'-restore-slot.json');await atomic(restorePath,{...configs[i+2],shopId:'HFM001',mysqlPath:'/usr/bin/mysql'});
      await atomic(control.preparationConfigPath,{schemaVersion:1,shopId:'HFM001',mode:'lost-local-copy',directory:path.join(root,i+'-preparation'),incomingToken:prepTokens[i],baselineIncomingToken:baselineTokens[i],pythonExecutable:'/usr/bin/python3',slots:[{restoreConfigPath:restorePath}],...(i?{dumpExecutable:'/usr/bin/mysqldump',dumpDefaultsFile:path.join(fixtureDirectory,'source-cloud.cnf')}:{peer:{url:cloudUrl+'/api/recovery-preparation',token:prepTokens[1],baselineToken:baselineTokens[1]}})});
      const supervisor=createRecoverySupervisor(control,{runCommand:command=>command.action==='stop'?stop(command.side):start(command.side)});
      await atomic(path.join(directory,'heartbeat.json'),{shopId:'HFM001',at:new Date().toISOString()});
      timers.push(setInterval(()=>atomic(path.join(directory,'heartbeat.json'),{shopId:'HFM001',at:new Date().toISOString()}).catch(error=>failures.push(error.message)),1000));
      timers.push(setInterval(()=>{if(!work[i])work[i]=supervisor.tick().catch(error=>failures.push(error.message)).finally(()=>{work[i]=null;});},200));
    }
    await start(1);await start(0);await until(async()=>(await ready(0)).sync?.ready&&(await ready(1)).sync?.ready,'initial enrolled startup');
    const barcode='RECOVERY'+crypto.randomBytes(8).toString('hex').toUpperCase(),product={barcode,original_barcode:barcode,product_code:barcode,code_mode:'MANUAL',product_name:'RECOVERY ACCEPTANCE',hsn_code:'TEST',gst_percent:0,unit_type:'PCS',purchase_unit_type:'PCS',purchase_unit_size:1,mrp:20,purchase_price:5,sale_price:10,stock_qty:10,min_stock_alert:1};
    await request(1,'products/save',product);
    const sale=()=>({checkout_request_id:crypto.randomUUID(),counter_no:1,customer_name:'RECOVERY CUSTOMER',customer_phone:'9876543210',items:[{barcode,product_name:product.product_name,quantity:1,sale_price:10,gst_percent:0}],sub_total:10,gst_total:0,grand_total:10,payment_mode:'Cash',cash_received:10,change_returned:0,billing_tier:'RETAIL',tax_type:'LOCAL'});
    await request(1,'billing/checkout',sale());
    const [[before]]=await pools[1].query('SELECT COUNT(*) AS n FROM invoices');assert.equal(Number(before.n),1);
    const state=await request(0,'recovery-control');assert.ok(state.preparation.allowedModes.includes('lost-local-copy'));
    const rejected=await fetch('http://127.0.0.1:5003/api/recovery-control',{method:'POST',headers:ownerHeaders,body:JSON.stringify({kind:'prepare-lost-local',expectedGeneration:state.generation,confirmation:'PREPARE VERIFIED CLOUD COPY AND RETURN LOCAL'})});assert.equal(rejected.status,400);
    dropRelease=true;
    await request(0,'recovery-control',{kind:'prepare-lost-local',expectedGeneration:state.generation,confirmation:'LOCAL SOURCE IS UNRECOVERABLE - PREPARE CLOUD COPY AND RETURN LOCAL'});
    await until(async()=>{const s=await request(0,'recovery-control');return ['failed','complete'].includes(s.operation?.state);},'snapshot preparation and reconnect',180000);
    let after=await request(0,'recovery-control');
    if(after.operation.state==='failed'){
      assert.equal(after.baseline?.installed,true,'failure must be deliberately lost final reply');assert.equal(after.billingMode,'active');
      await request(0,'recovery-control',{kind:'copy-lost-local',expectedGeneration:after.generation,confirmation:'LOCAL SOURCE IS UNRECOVERABLE - COPY CLOUD AND RETAIN OLD DATABASE'});
      await until(async()=>(await request(0,'recovery-control')).operation?.state==='complete','resume after lost reply');
    }
    after=await request(0,'recovery-control');assert.equal(after.billingMode,'active');assert.equal(after.baseline.state,'complete');assert.equal((await request(1,'recovery-control')).billingMode,'standby');
    const [[localBill]]=await pools[2].query('SELECT customer_name,customer_phone FROM invoices');assert.equal(localBill.customer_name,'RECOVERY CUSTOMER');assert.equal(localBill.customer_phone,'9876543210');
    const [[oldLocal]]=await pools[0].query('SELECT COUNT(*) AS n FROM invoices');assert.equal(Number(oldLocal.n),0,'old local database retained unchanged');
    const [[oldCloud]]=await pools[1].query('SELECT COUNT(*) AS n FROM invoices');assert.equal(Number(oldCloud.n),1,'original cloud history retained');
    const wrong=await fetch('http://127.0.0.1:5004/api/sync/status',{headers:{Authorization:'Bearer '+syncTokens[1],'X-Badizo-Baseline':oldBaseline}});assert.equal(wrong.status,409);
    await request(0,'billing/checkout',sale());await request(0,'cloud-sync/run',{});
    await until(async()=>{const [[row]]=await pools[3].query('SELECT COUNT(*) AS n FROM invoices');return Number(row.n)===2;},'new local sale reaches rebuilt cloud');
    const denied=await fetch('http://127.0.0.1:5004/api/billing/checkout',{method:'POST',headers:ownerHeaders,body:JSON.stringify(sale())});assert.equal(denied.status,409);
    assert.deepEqual(failures,[]);
    console.log(JSON.stringify({ownerButtonPreparation:true,actualCloudExportAndTwoRestores:true,customerNameAndMobilePreserved:true,sourceDatabasesRetained:true,localOnlyBilling:true,newBaselineRejectsOldRequests:true,newSalesSynchronize:true,lostFinalReplyResumable:true,productionModified:false,protectedEvidence:root}));
  }finally{timers.forEach(clearInterval);await Promise.all(work.filter(Boolean));await stop(0);await stop(1);if(proxy)await new Promise(resolve=>proxy.close(resolve));await Promise.all(pools.map(pool=>pool.end()));}
}
main().catch(error=>{console.error('Baseline reconnect acceptance failed: '+error.message);process.exitCode=1;});
