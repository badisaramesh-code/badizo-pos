const fs=require('node:fs/promises'),path=require('node:path');
const {createCloudSyncRuntime}=require('./cloudSyncRuntime');
const {createCloudSyncSettingsService}=require('./cloudSyncSettingsService');
const {createRecoveryReviewStore}=require('./recoveryReviewStore');
const {createPosSyncReceiver}=require('./posSyncReceiver');
const {createSyncHttpTransport}=require('./syncHttpTransport');
const {createSyncPullClient}=require('./syncPullClient');
const {createOutgoingFeed}=require('./syncOutgoingFeed');
const {peerAuthentication}=require('../routes/syncReceiver');
const runtimeBinding=require('./recoveryRuntimeBinding');
const captureFlags=['BADIZO_SYNC_PRODUCT_CAPTURE','BADIZO_SYNC_STOCK_CAPTURE','BADIZO_SYNC_PURCHASE_CAPTURE','BADIZO_SYNC_CHECKOUT_CAPTURE'];
const requiredTables=['sync_enrollment','sync_inbox','sync_outbox','sync_worker_state','sync_invoice_map','sync_invoice_item_map','sync_invoice_batch_map','sync_stock_adjustment_map','sync_supplier_payment_map','sync_recovery_applications','sync_checkout_requests'];
function validateConfiguration(value,env){
  const keys=['schemaVersion','shopId','installationId','peerInstallationId','nodeRole','databaseName','baselineId','activationId','contractVersion','settingsDirectory','reviewDirectory','incomingToken','peer'];
  if(!value||Object.keys(value).some(key=>!keys.includes(key))||value.schemaVersion!==1||value.contractVersion!==1
    ||!/^[_a-zA-Z0-9]{1,64}$/.test(value.databaseName||'')||!/^[A-Z][A-Z0-9_-]{2,31}$/.test(value.shopId||'')
    ||![value.installationId,value.peerInstallationId].every(id=>/^[A-Za-z0-9_-]{3,64}$/.test(id||''))||value.installationId===value.peerInstallationId
    ||!/^[a-f0-9]{64}$/.test(value.baselineId||'')||!/^[a-f0-9-]{36}$/.test(value.activationId||'')
    ||!path.isAbsolute(value.settingsDirectory||'')||!path.isAbsolute(value.reviewDirectory||'')||!/^[a-f0-9]{64,128}$/.test(value.incomingToken||'')
    ||value.shopId!==env.BADIZO_SHOP_ID||value.nodeRole!==(env.BADIZO_NODE_ROLE||'local-server')||!['local-server','cloud-standby','cloud-active'].includes(value.nodeRole))throw Error('Invalid or mismatched sync enrollment configuration.');
  if(value.nodeRole==='local-server'){
    if(!value.peer||Object.keys(value.peer).sort().join(',')!=='baseUrl,token'||!/^[a-f0-9]{64,128}$/.test(value.peer.token||''))throw Error('Local sync requires a dedicated peer connection.');
    const url=new URL(value.peer.baseUrl);
    if(url.protocol!=='https:'||url.username||url.password||url.search||url.hash||url.pathname.replace(/\/$/,'')!=='/api/sync')throw Error('Peer must use the secured /api/sync endpoint.');
  }else if(value.peer!==null)throw Error('Cloud sync is pulled by the local server; do not configure a reverse network connection.');
  return value;
}
async function createEnrolledSyncRuntime({pool,configPath,env=process.env,withTransfer=runtimeBinding.withWriteLease}){
  if(!path.isAbsolute(configPath||''))throw Error('Protected enrollment configuration path required.');
  const config=validateConfiguration(JSON.parse(await fs.readFile(configPath,'utf8')),env);
  for(const flag of captureFlags)env[flag]='false';
  env.BADIZO_CHECKOUT_REQUEST_GUARD='false';
  const binding=runtimeBinding.read(env);
  if(!binding)throw Error('Enrolled sync requires a verified runtime database binding.');
  const identity={shopId:config.shopId,localInstallationId:config.installationId,peerInstallationId:config.peerInstallationId};
  const reviewStore=createRecoveryReviewStore({directory:config.reviewDirectory,shopId:config.shopId});
  if(binding.activationId!==config.activationId){
    // A restored database must never inherit the old installation's mapping
    // identities silently. Keep local billing available, but require a newly
    // verified baseline before incremental sync is resumed.
    const settings=createCloudSyncSettingsService({configDirectory:config.settingsDirectory,nodeRole:config.nodeRole,getWorkerState:async()=>({ready:false,reason:'restored-database-requires-enrollment'})});
    return {settings,reviewStore,identity,mount:router=>router.use((_req,res)=>res.status(409).json({error:'Sync requires a newly verified recovery baseline.'})),start:()=>{},stop:()=>{},status:async()=>({ready:false,reason:'restored-database-requires-enrollment'})};
  }
  if(binding.database.database!==config.databaseName)throw Error('Sync enrollment belongs to a different database.');
  const [[database]]=await pool.query('SELECT DATABASE() AS name,VERSION() AS version');
  if(database.name!==config.databaseName||!/^8\.0\./.test(database.version))throw Error('Sync requires the enrolled MySQL 8.0 database.');
  const [tables]=await pool.query('SELECT TABLE_NAME AS name,ENGINE AS engine FROM information_schema.tables WHERE table_schema=DATABASE() AND table_name IN ('+requiredTables.map(()=>'?').join(',')+')',requiredTables);
  if(requiredTables.some(name=>!tables.some(row=>row.name===name&&row.engine==='InnoDB')))throw Error('Sync migrations have not been installed and verified.');
  async function enrolled(){
    const [rows]=await pool.execute('SELECT * FROM sync_enrollment WHERE singleton=1');
    const row=rows[0];
    return rows.length===1&&row.shop_id===config.shopId&&row.installation_id===config.installationId&&row.peer_installation_id===config.peerInstallationId&&row.baseline_id===config.baselineId&&row.activation_id===config.activationId&&Number(row.contract_version)===config.contractVersion&&Number(row.enabled)===1;
  }
  if(!await enrolled())throw Error('Database enrollment is absent, disabled or mismatched.');
  async function canTransfer(){
    const state=runtimeBinding.read(env);
    return state?.activationId===config.activationId&&state.phase==='active'&&await enrolled();
  }
  async function canCorrect(){return config.nodeRole==='local-server'&&!runtimeBinding.read(env)?.handoffId&&await canTransfer();}
  const financialCorrections=require('./financialCorrectionExecution').createFinancialCorrectionExecution({pool,identity,nodeRole:config.nodeRole,canApply:canCorrect,withWriteLease:withTransfer});
  const financialCases=require('./financialConflictCases').createFinancialConflictCases({directory:path.join(config.reviewDirectory,'financial'),identity,pool});
  const receiveBase=createPosSyncReceiver({pool,identity,retainReceived:true,reviewStore:config.nodeRole==='local-server'?reviewStore:null,localPriority:async()=>{
    const state=runtimeBinding.read(env);return config.nodeRole==='local-server'&&state?.preferLocalConflicts===true&&await canTransfer();
  }});
  const receive=async event=>{try{return await receiveBase(event);}catch(error){if(!error.code)await financialCases.record(event);throw error;}};
  const feed=createOutgoingFeed({pool,identity});
  async function status(){return {ready:await canTransfer(),shopId:config.shopId,installationId:config.installationId,peerInstallationId:config.peerInstallationId,baselineId:config.baselineId,contractVersion:config.contractVersion};}
  let workerRuntime=null;
  if(config.nodeRole==='local-server'){
    const base=config.peer.baseUrl.replace(/\/$/,'');
    async function verifyPeer(){
      const response=await fetch(base+'/status',{redirect:'error',signal:AbortSignal.timeout(10000),headers:{Authorization:'Bearer '+config.peer.token,'X-Badizo-Baseline':config.baselineId}});
      if(!response.ok){await response.body?.cancel();throw Error('Peer enrollment is unavailable.');}
      const reader=response.body.getReader();let text='';
      try{for(;;){const {done,value}=await reader.read();if(done)break;text+=Buffer.from(value).toString('utf8');if(text.length>8192)throw Error('Invalid peer enrollment response.');}}
      catch(error){await reader.cancel().catch(()=>{});throw error;}finally{reader.releaseLock();}
      const peer=JSON.parse(text);
      if(peer.ready!==true||peer.shopId!==config.shopId||peer.installationId!==config.peerInstallationId||peer.peerInstallationId!==config.installationId||peer.baselineId!==config.baselineId||peer.contractVersion!==config.contractVersion)throw Error('Peer baseline or identity does not match.');
    }
    workerRuntime=createCloudSyncRuntime({pool,identity,configDirectory:config.settingsDirectory,canTransfer,withTransfer,beforeTransfer:verifyPeer,
      send:createSyncHttpTransport({url:base+'/events',token:config.peer.token,baselineId:config.baselineId}),
      pull:createSyncPullClient({pool,identity,url:base+'/feed',token:config.peer.token,baselineId:config.baselineId,receive,mayApply:canTransfer})});
  }
  const settings=workerRuntime?.settings||createCloudSyncSettingsService({configDirectory:config.settingsDirectory,nodeRole:config.nodeRole,getWorkerState:status});
  function mount(router){
    router.use(peerAuthentication(config.incomingToken));
    router.use((req,res,next)=>req.headers['x-badizo-baseline']===config.baselineId?next():res.status(409).json({error:'Sync baseline mismatch.'}));
    router.get('/status',async(_req,res)=>{try{res.json(await status());}catch{res.status(503).json({error:'Enrollment unavailable.'});}});
    if(env.BADIZO_RECOVERY_CONTROL_CONFIG){
      const control=require('./recoveryControl').createRecoveryControl({configPath:env.BADIZO_RECOVERY_CONTROL_CONFIG,shopId:config.shopId});
      router.get('/handoff',async(_req,res)=>{
        try{
          // The supervisor must be able to observe a legitimate write-drain
          // phase. Transfer endpoints still reject validating, but hiding
          // status during that phase turns ordinary polling into a failed
          // switch depending on request timing.
          const state=runtimeBinding.read(env);
          if(state?.activationId!==config.activationId||!await enrolled())throw Error('Enrollment unavailable');
          const [[row]]=await pool.execute('SELECT COUNT(*) AS n FROM sync_outbox WHERE shop_id=? AND origin_installation_id=? AND acknowledged_at IS NULL',[identity.shopId,identity.localInstallationId]);
          res.json({...await control.status(),shopId:config.shopId,installationId:config.installationId,peerInstallationId:config.peerInstallationId,baselineId:config.baselineId,activeWrites:runtimeBinding.status()?.activeWrites??-1,pending:Number(row.n)});
        }catch{res.status(409).json({error:'Handoff state unavailable.'});}
      });
      router.post('/handoff',require('express').json({limit:'4kb'}),async(req,res)=>{
        try{
          const value=req.body;
          if(!await canTransfer()||config.nodeRole==='local-server'||!value||Object.keys(value).sort().join(',')!=='action,expectedGeneration,handoffId'||!['pause','activate'].includes(value.action))throw Error('Invalid handoff');
          const current=runtimeBinding.read(env);
          if(value.action==='activate'&&(current.handoffId!==value.handoffId||current.billingMode!=='standby'))throw Error('Pause identity differs');
          res.status(202).json(await control.request({kind:value.action==='pause'?'handoff-standby':'handoff-active',handoffId:value.handoffId,expectedGeneration:value.expectedGeneration,actor:'enrolled-peer:'+config.peerInstallationId}));
        }catch{res.status(409).json({error:'Handoff request rejected; inspect current status.'});}
      });
      router.post('/handoff/flush',require('express').json({limit:'4kb'}),async(req,res)=>{
        try{
          const current=runtimeBinding.read(env);
          if(!workerRuntime||!req.body||Object.keys(req.body).join(',')!=='handoffId'||current.handoffId!==req.body.handoffId||current.billingMode!=='standby'||!await canTransfer())throw Error('Not paused');
          res.json(await workerRuntime.flush({limit:10}));
        }catch{res.status(409).json({error:'Handoff synchronization failed; resolve pending conflicts before activation.'});}
      });
    }
    router.use('/events',require('../routes/syncReceiver').createRouter({token:config.incomingToken,receive,mayReceive:canTransfer}));
    router.use('/feed',require('../routes/syncFeed').createRouter({token:config.incomingToken,feed,mayShare:canTransfer}));
  }
  env.BADIZO_INSTALLATION_ID=config.installationId;env.BADIZO_SYNC_PEER_INSTALLATION_ID=config.peerInstallationId;
  for(const flag of captureFlags)env[flag]='true';
  env.BADIZO_CHECKOUT_REQUEST_GUARD='true';
  return {settings,reviewStore,financialCases,financialCorrections,retryFinancial:receive,identity,mount,status,worker:workerRuntime?.worker,start:()=>workerRuntime?.start(),stop:()=>workerRuntime?.stop()};
}
module.exports={createEnrolledSyncRuntime,validateConfiguration,requiredTables};
