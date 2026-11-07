const fs=require('node:fs/promises'),nativeFs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {spawn}=require('node:child_process');
const {Transform,Readable}=require('node:stream');
const {pipeline}=require('node:stream/promises');
const mysql=require('mysql2/promise');
const {atomic,json}=require('./recoveryControlFiles');
const {validate}=require('./recoveryRuntimeBinding');
const {fingerprintBusiness,sourceShopIdentity}=require('./recoveryBaselineEnrollment');
const {prepareSingleBaseline}=require('./recoverySingleBaselinePreparation');
const {canonical}=require('./syncEventProtocol');
const uuid=value=>/^[a-f0-9-]{36}$/.test(value||'');
const sha=value=>/^[a-f0-9]{64}$/.test(value||'');
const hash=value=>crypto.createHash('sha256').update(canonical(value)).digest('hex');
const candidateName=value=>/^badizo_recovery_[a-z0-9]{8,32}$/.test(value||'');

async function configuration(supervisor){
  if(!path.isAbsolute(supervisor.preparationConfigPath||'')||!path.isAbsolute(supervisor.baselinePlanPath||''))throw Error('Recovery preparation has not been installed.');
  const config=await json(supervisor.preparationConfigPath);
  config.mode=config.mode||'verified-copy';config.allowedModes=config.allowedModes||['verified-copy','lost-local-copy'];
  if(config.schemaVersion!==1||config.shopId!==supervisor.shopId||!path.isAbsolute(config.directory||'')||!sha(config.incomingToken)||!sha(config.baselineIncomingToken)||!['verified-copy','lost-local-copy'].includes(config.mode)||!Array.isArray(config.slots)||!config.slots.length||config.slots.length>20||config.slots.some(slot=>!path.isAbsolute(slot.restoreConfigPath||'')))throw Error('Invalid protected preparation configuration.');
  config.maxBytes=config.maxBytes||2*1024**3;
  if(!Array.isArray(config.allowedModes)||!config.allowedModes.length||config.allowedModes.some(mode=>!['verified-copy','lost-local-copy'].includes(mode)))throw Error('Invalid recovery preparation modes.');
  if(!Number.isSafeInteger(config.maxBytes)||config.maxBytes<1024||config.maxBytes>20*1024**3)throw Error('Invalid recovery size limit.');
  if(supervisor.nodeRole==='local-server'){
    const url=new URL(config.peer?.url);
    if(url.protocol!=='https:'||url.username||url.password||url.search||url.hash||url.pathname!=='/api/recovery-preparation'||!sha(config.peer?.token)||!sha(config.peer?.baselineToken))throw Error('Protected HTTPS cloud recovery connection required.');
  }else if(!path.isAbsolute(config.dumpExecutable||'')||!path.isAbsolute(config.dumpDefaultsFile||''))throw Error('Protected cloud export configuration required.');
  return config;
}
async function digestFile(file,maxBytes){
  const digest=crypto.createHash('sha256');let bytes=0;
  const stat=await fs.lstat(file);if(!stat.isFile()||stat.isSymbolicLink())throw Error('Regular recovery artifact required.');
  for await(const chunk of nativeFs.createReadStream(file)){bytes+=chunk.length;if(bytes>maxBytes)throw Error('Recovery artifact exceeds configured size limit.');digest.update(chunk);}
  if(!bytes)throw Error('Recovery artifact is empty.');return {sha256:digest.digest('hex'),bytes};
}
async function checkSpace(directory,bytes){
  const stat=await fs.statfs(directory);if(Number(stat.bavail)*Number(stat.bsize)<bytes)throw Error('Insufficient disk space for recovery. Free space before retrying.');
}
async function receiveArtifact(body,file,manifest,maxBytes){
  let bytes=0;const digest=crypto.createHash('sha256');
  const meter=new Transform({transform(chunk,_encoding,callback){bytes+=chunk.length;if(bytes>manifest.sqlBytes||bytes>maxBytes)return callback(Error('Cloud snapshot exceeds declared size.'));digest.update(chunk);callback(null,chunk);}});
  await pipeline(body,meter,nativeFs.createWriteStream(file,{flags:'wx',mode:0o600}));
  if(bytes!==manifest.sqlBytes||digest.digest('hex')!==manifest.sqlSha256)throw Error('Downloaded cloud snapshot failed checksum verification.');
  const handle=await fs.open(file,'r+');try{await handle.sync();}finally{await handle.close();}
}
async function boundedJson(response,maxBytes=1024*1024){
  if(!response.body)throw Error('Missing cloud recovery response.');
  const chunks=[];let bytes=0;
  for await(const chunk of Readable.fromWeb(response.body)){bytes+=chunk.length;if(bytes>maxBytes)throw Error('Cloud metadata exceeds recovery limit.');chunks.push(chunk);}
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
async function sourceEvidence(database,shopId){
  const connection=await mysql.createConnection({...database,connectTimeout:10000});
  try{return {identity:await sourceShopIdentity(connection,shopId),fingerprint:await fingerprintBusiness(connection)};}finally{await connection.end();}
}
async function dump(config,binding,target,onSpawn=async()=>{}){
  // Defaults hold credentials only; override the endpoint to match the runtime.
  if(binding.database.port&&binding.database.port!==3306)throw Error('Unsupported recovery MySQL port.');
  const child=spawn(config.dumpExecutable,['--defaults-extra-file='+config.dumpDefaultsFile,'--protocol=TCP','--host='+binding.database.host,'--port=3306','--single-transaction','--routines','--triggers','--events','--hex-blob','--no-tablespaces','--set-gtid-purged=OFF',binding.database.database],{windowsHide:true,shell:false,stdio:['ignore','pipe','ignore']});
  let bytes=0,tail=Buffer.alloc(0);
  const meter=new Transform({transform(chunk,_encoding,callback){bytes+=chunk.length;if(bytes>config.maxBytes)return callback(Error('Cloud export exceeds recovery size limit.'));tail=Buffer.concat([tail,chunk]).subarray(-4096);callback(null,chunk);}});
  const done=new Promise((resolve,reject)=>{child.once('error',()=>reject(Error('Cloud export could not start.')));child.once('exit',code=>code===0?resolve():reject(Error('Cloud export failed.')));});
  try{await onSpawn(child.pid);await Promise.all([done,pipeline(child.stdout,meter,nativeFs.createWriteStream(target,{flags:'wx',mode:0o600}))]);if(!tail.toString('utf8').includes('Dump completed'))throw Error('Cloud export did not finish.');const file=await fs.open(target,'r+');try{await file.sync();}finally{await file.close();}}
  catch(error){child.kill();throw error;}
}
async function restore(config,file,onSpawn=async()=>{}){
  const child=spawn(config.pythonExecutable||'python',[require('./restoreScriptPath'),file],{windowsHide:true,shell:false,stdio:['ignore','pipe','ignore']});
  let output='',overflow=false;
  child.stdout.on('data',data=>{if(output.length+data.length>65536)overflow=true;else output+=data.toString();});
  const done=new Promise((resolve,reject)=>{child.once('error',()=>reject(Error('Restore process could not start.')));child.once('close',code=>{if(code!==0||overflow)return reject(Error('Restore failed; partial candidate retained.'));try{resolve(JSON.parse(output));}catch{reject(Error('Invalid restore result.'));}});});
  try{await onSpawn(child.pid);return await done;}catch(error){child.kill();throw error;}
}
function processAlive(pid){if(!Number.isSafeInteger(pid)||pid<=0)return true;try{process.kill(pid,0);return true;}catch(error){if(error.code==='ESRCH')return false;return true;}}
function validateMetadata(value,config,operationId){
  const report=value?.report,manifest=value?.manifest;
  if(value?.shopId!==config.shopId||value.operationId!==operationId||value.mode!==config.mode||!report||report.operationId!==operationId||report.shopId!==config.shopId||!sha(report.baselineId)||!sha(report.businessFingerprint?.hash)||!sha(manifest?.sqlSha256)||manifest.shopId!==config.shopId||manifest.integrityVerified!==true||manifest.shopIdentityVerified!==true||!Number.isSafeInteger(manifest.sqlBytes)||manifest.sqlBytes<=0||manifest.sqlBytes>config.maxBytes||report.sqlSha256!==manifest.sqlSha256||!Array.isArray(report.activationIds)||report.activationIds.length!==2||!report.activationIds.every(uuid)||!Array.isArray(report.installationIds)||report.installationIds.length!==2||report.installationIds.some(id=>!/^(local|cloud)-[a-f0-9-]{36}$/.test(id))||report.installationIds[0]===report.installationIds[1]||!Array.isArray(report.databases)||report.databases.length!==2||!candidateName(report.databases[1])||report.sourceShopIdentityVerified!==true)throw Error('Cloud recovery metadata failed identity verification.');
  if(report.baselineId!==hash({shopId:config.shopId,sqlSha256:manifest.sqlSha256,businessHash:report.businessFingerprint.hash}))throw Error('Cloud recovery fingerprint identity differs.');
  return value;
}
function createRecoveryPreparation(supervisor,{waitReady,inspect=sourceEvidence,exportSql=dump,restoreSql=restore,prepareCandidate=prepareSingleBaseline,space=checkSpace}={}){
  async function paths(operationId){const config=await configuration(supervisor);if(!uuid(operationId))throw Error('Invalid preparation operation.');return {config,directory:path.join(config.directory,operationId),job:path.join(config.directory,operationId,'preparation.json')};}
  async function read(operationId){const p=await paths(operationId);return {...p,state:await json(p.job)};}
  async function record(p,state){await atomic(p.job,state);await atomic(path.join(p.config.directory,'current.json'),{operationId:state.operationId});}
  async function current(){return validate(await json(supervisor.bindingPath),supervisor.shopId);}
  async function pause(operationId){
    const binding=await current();
    if(binding.handoffId&&binding.handoffId!==operationId)throw Error('Another recovery operation owns this server.');
    await atomic(supervisor.bindingPath,{...binding,phase:'validating',billingMode:'standby',handoffId:operationId,generation:binding.generation+1});
    await waitReady(binding.activationId,{drained:true});return binding;
  }
  async function selectSlot(p,state){
    if(state.slot){const slot=await json(state.slot.restoreConfigPath);if(slot.database!==state.slot.database)throw Error('Recovery slot configuration changed.');return slot;}
    const binding=await current();
    for(const selected of p.config.slots){
      const slot=await json(selected.restoreConfigPath);
      if(slot.shopId!==supervisor.shopId||!candidateName(slot.database)||!['localhost','127.0.0.1'].includes(slot.host)||slot.database===binding.database.database)throw Error('Invalid protected recovery slot.');
      if(state.retainedPartialSlots?.some(previous=>previous.database===slot.database))continue;
      const reservation=path.join(p.config.directory,slot.database+'.reservation.json');
      let reserved;try{reserved=await json(reservation);}catch(error){if(error.code!=='ENOENT')throw error;}
      if(reserved&&reserved.operationId!==state.operationId)continue;
      const connection=await mysql.createConnection({host:slot.host,user:slot.user,password:slot.password,database:slot.database,connectTimeout:10000});
      let empty;try{const [[row]]=await connection.query('SELECT COUNT(*) AS n FROM information_schema.tables WHERE table_schema=DATABASE()');empty=Number(row.n)===0;}finally{await connection.end();}
      if(!empty)continue;
      if(!reserved){const handle=await fs.open(reservation,'wx',0o600);try{await handle.writeFile(JSON.stringify({operationId:state.operationId,database:slot.database}));await handle.sync();}finally{await handle.close();}}
      state.slot={restoreConfigPath:selected.restoreConfigPath,database:slot.database};await record(p,state);return slot;
    }
    throw Error('No unused empty recovery slot remains. The installer must provision another slot; existing databases were retained.');
  }
  async function restoreCandidate(p,state,metadata){
    const artifactDirectory=path.join(p.directory,'artifact');
    const restoreFile=path.join(p.directory,'restore-config.json'),resultFile=path.join(artifactDirectory,'restore-result.json');
    let result;try{result=await json(resultFile);}catch(error){if(error.code!=='ENOENT')throw error;}
    if(!result&&state.restoreStarted){
      // An OS process may survive its supervisor. Never import concurrently or
      // kill a reused PID. Once confirmed absent, retain its DB and use a fresh slot.
      if(processAlive(state.restorePid))throw Error('The previous restore process may still be running. Wait before retrying.');
      state.retainedPartialSlots=[...(state.retainedPartialSlots||[]),state.slot];state.slot=null;state.restoreStarted=false;state.restorePid=null;await record(p,state);
    }
    const slot=await selectSlot(p,state),database={host:slot.host,user:slot.user,password:slot.password,database:slot.database};
    if(!result){
      await atomic(restoreFile,{...slot,artifactDirectory,sourceDatabase:metadata.sourceDatabase});
      state.restoreStarted=true;state.state='restoring';await record(p,state);
      result=await restoreSql(p.config,restoreFile,async pid=>{state.restorePid=pid;await record(p,state);});
    }
    if(result.shopId!==supervisor.shopId||result.database!==database.database||result.sqlSha256!==metadata.manifest.sqlSha256||result.stagedRestoreVerified!==true||result.activated!==false)throw Error('Restored candidate did not verify.');
    const report={...metadata.report,databases:[...metadata.report.databases]};report.databases[supervisor.nodeRole==='local-server'?0:1]=database.database;
    const prepared=await prepareCandidate({database,report,index:supervisor.nodeRole==='local-server'?0:1,directory:p.directory,bindingPath:supervisor.bindingPath});
    report.prepared=[...report.prepared];report.prepared[supervisor.nodeRole==='local-server'?0:1]=true;
    state.report=report;state.metadata={...metadata,report};state.prepared=true;state.state='candidate-prepared';state.archive=prepared.archive;await record(p,state);
    return {database,report};
  }
  async function exportCloud(operationId,mode){
    if(supervisor.nodeRole==='local-server')throw Error('Only cloud exports recovery snapshots.');
    const p=await paths(operationId);await fs.mkdir(p.directory,{recursive:true,mode:0o700});
    mode=mode||p.config.mode;if(!p.config.allowedModes.includes(mode))throw Error('Recovery mode is not permitted.');p.config.mode=mode;
    let previous;try{previous=await json(path.join(p.config.directory,'current.json'));}catch(error){if(error.code!=='ENOENT')throw error;}
    if(previous&&previous.operationId!==operationId){
      const binding=await current();let completed;try{completed=await json(path.join(supervisor.directory,'baseline-node.json'));}catch(error){if(error.code!=='ENOENT')throw error;}
      let cancelled=false;try{cancelled=(await read(previous.operationId)).state.state==='cancelled';}catch{}
      if(binding.handoffId||binding.phase!=='active'||(!cancelled&&(completed?.operationId!==previous.operationId||!['released','complete'].includes(completed.state))))throw Error('An earlier cloud recovery operation must finish before starting another.');
    }
    let state;try{state=await json(p.job);}catch(error){if(error.code!=='ENOENT')throw error;}
    if(state&&state.mode!==mode)throw Error('Recovery mode cannot change during an operation.');
    if(!state){const binding=await pause(operationId);state={operationId,shopId:supervisor.shopId,mode:p.config.mode,sourceActivationId:binding.activationId,sourceDatabase:binding.database.database,state:'paused'};await record(p,state);}
    const bound=await current();if(bound.activationId!==state.sourceActivationId||bound.handoffId!==operationId||bound.phase!=='validating'||bound.billingMode!=='standby')throw Error('Cloud source is not held at its recovery checkpoint.');
    if(state.prepared)return status(operationId);
    if(!state.metadata){
      const evidence=await inspect(bound.database,supervisor.shopId);await space(p.directory,p.config.maxBytes*3);
      const artifactDirectory=path.join(p.directory,'artifact');await fs.mkdir(artifactDirectory,{recursive:true,mode:0o700});
      const sql=path.join(artifactDirectory,'database.sql');
      // A partial export is kept as evidence; never adopt it on retry.
      if(state.exportStarted){
        if(processAlive(state.exportPid))throw Error('The previous export process may still be running. Wait before retrying.');
        await fs.rename(sql,sql+'.partial-'+crypto.randomUUID()).catch(error=>{if(error.code!=='ENOENT')throw error;});
      }
      state.exportStarted=true;await record(p,state);await exportSql(p.config,bound,sql,async pid=>{state.exportPid=pid;await record(p,state);});
      const digest=await digestFile(sql,p.config.maxBytes);
      if((await inspect(bound.database,supervisor.shopId)).fingerprint.hash!==evidence.fingerprint.hash)throw Error('Cloud source changed during export.');
      const held=await current();if(held.activationId!==state.sourceActivationId||held.handoffId!==operationId||held.phase!=='validating'||held.billingMode!=='standby')throw Error('Cloud recovery hold was lost during export.');
      const manifest={schemaVersion:1,shopId:supervisor.shopId,source:'cloud-export',sourceSha256:digest.sha256,sourceBytes:digest.bytes,sqlSha256:digest.sha256,sqlBytes:digest.bytes,integrityVerified:true,shopIdentityVerified:true,restoreVerified:false,activated:false};
      await atomic(path.join(artifactDirectory,'manifest.json'),manifest);
      const report={schemaVersion:1,operationId,shopId:supervisor.shopId,baselineId:hash({shopId:supervisor.shopId,sqlSha256:digest.sha256,businessHash:evidence.fingerprint.hash}),businessFingerprint:evidence.fingerprint,sqlSha256:digest.sha256,installationIds:['local-'+crypto.randomUUID(),'cloud-'+crypto.randomUUID()],activationIds:[crypto.randomUUID(),crypto.randomUUID()],databases:[null,null],prepared:[false,false],sourceShopIdentityVerified:true,sourceShopIdentityEvidence:[evidence.identity,evidence.identity],readyForProtectedEnrollment:false,state:'preparing',syncEnabled:false,activated:false,originalHistoriesMerged:false,requiresFinalSourceCheckpoint:true};
      state.metadata={operationId,shopId:supervisor.shopId,mode:p.config.mode,sourceDatabase:state.sourceDatabase,manifest,report};await record(p,state);
    }
    const prepared=await restoreCandidate(p,state,state.metadata);state.metadata.report=prepared.report;state.metadata.report.prepared[1]=true;await record(p,state);
    return status(operationId);
  }
  async function status(operationId){
    const config=await configuration(supervisor);
    if(!operationId){try{operationId=(await json(path.join(config.directory,'current.json'))).operationId;}catch(error){if(error.code==='ENOENT')return {configured:true,mode:config.mode,allowedModes:config.allowedModes,state:'ready'};throw error;}}
    const {state}=await read(operationId);
    let activation;try{activation=await json(path.join(supervisor.directory,'baseline-node.json'));}catch(error){if(error.code!=='ENOENT')throw error;}
    const binding=await current();
    const activationStarted=activation?.operationId===operationId&&activation.state!=='source-verified';
    const canResumeOriginal=supervisor.nodeRole==='local-server'&&state.state!=='prepared-disabled'&&!activationStarted&&binding.activationId===state.sourceActivationId&&binding.handoffId===operationId&&binding.phase==='validating'&&binding.billingMode==='standby';
    return {configured:true,shopId:supervisor.shopId,operationId,mode:state.mode,allowedModes:config.allowedModes,state:state.state,canResumeOriginal,pendingPeerCancel:state.pendingPeerCancel===true,metadata:state.prepared?state.metadata:null};
  }
  async function artifact(operationId){
    const p=await read(operationId);if(!p.state.prepared)throw Error('Cloud snapshot is not ready.');
    const file=path.join(p.directory,'artifact','database.sql'),digest=await digestFile(file,p.config.maxBytes);
    if(digest.sha256!==p.state.metadata.manifest.sqlSha256||digest.bytes!==p.state.metadata.manifest.sqlBytes)throw Error('Cloud snapshot changed.');
    return {file,bytes:digest.bytes};
  }
  async function writePlan(p,state,report,database){
    const reportPath=path.join(p.directory,'prepared-report.json');await atomic(reportPath,report);
    const local=supervisor.nodeRole==='local-server';
    const peer=local?{url:p.config.peer.url.replace('/api/recovery-preparation','/api/recovery-baseline'),token:p.config.peer.baselineToken}:null;
    await atomic(supervisor.baselinePlanPath,{schemaVersion:1,shopId:supervisor.shopId,side:local?0:1,mode:state.mode,operationId:state.operationId,reportPath,incomingToken:p.config.baselineIncomingToken,sourceActivationId:state.sourceActivationId,database,peer});
  }
  async function finalize(operationId,localDatabase){
    if(supervisor.nodeRole==='local-server'||!candidateName(localDatabase))throw Error('Invalid cloud preparation finalization.');
    const p=await read(operationId),{state}=p;if(!state.prepared)throw Error('Cloud candidate is not prepared.');
    p.config.mode=state.mode;
    const latest=await json(path.join(p.config.directory,'current.json'));
    if(latest.operationId!==operationId)throw Error('A newer recovery operation owns the prepared plan.');
    if(state.state==='prepared-disabled'&&state.metadata.report.databases[0]!==localDatabase)throw Error('Prepared local target cannot change after confirmation.');
    const held=await current();
    const originalHeld=held.activationId===state.sourceActivationId&&held.handoffId===operationId&&held.phase==='validating'&&held.billingMode==='standby';
    const sameFinalized=state.state==='prepared-disabled'&&held.activationId===state.metadata.report.activationIds[1]&&held.billingMode==='standby';
    if(!originalHeld&&!sameFinalized)throw Error('Cloud recovery hold changed before finalization.');
    if(sameFinalized)return status(operationId);
    const report={...state.metadata.report,databases:[localDatabase,state.metadata.report.databases[1]],prepared:[true,true],state:'prepared-disabled',readyForProtectedEnrollment:true};
    const slot=await json(state.slot.restoreConfigPath);
    await writePlan(p,state,report,{host:slot.host,user:slot.user,password:slot.password,database:slot.database});
    state.metadata.report=report;state.state='prepared-disabled';await record(p,state);return status(operationId);
  }
  async function peer(config,suffix='',body){
    const response=await fetch(config.peer.url+suffix,{method:body?'POST':'GET',redirect:'error',signal:AbortSignal.timeout(20000),headers:{Authorization:'Bearer '+config.peer.token,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});
    if(!response.ok){await response.body?.cancel();throw Error('Cloud preparation endpoint unavailable.');}return boundedJson(response);
  }
  async function cancelPeer(config,operationId){
    const result=await peer(config,'',{action:'cancel',operationId});
    if(result.cancelled!==true||result.operationId!==operationId||result.cloudStandby!==true)throw Error('Cloud did not confirm cancellation of this recovery operation.');
    return result;
  }
  async function cancelCloud(operationId){
    if(supervisor.nodeRole==='local-server')throw Error('Cloud cancellation endpoint required.');
    const p=await read(operationId),{state}=p,latest=await json(path.join(p.config.directory,'current.json')),binding=await current();
    let operation;try{operation=await json(path.join(supervisor.directory,'operation.json'));}catch(error){if(error.code!=='ENOENT')throw error;}
    if(operation&&!['complete','failed','rolled-back'].includes(operation.state))throw Error('Cloud recovery is still running. Retry cancellation after it finishes.');
    if(latest.operationId!==operationId||binding.activationId!==state.sourceActivationId||binding.billingMode!=='standby'||(binding.handoffId&&binding.handoffId!==operationId))throw Error('Cloud recovery already advanced or another operation owns it.');
    if(state.state!=='cancelled'&&binding.phase!=='validating')throw Error('Cloud source is not paused for cancellation.');
    state.state='cancelled';await record(p,state);
    await atomic(supervisor.bindingPath,{...binding,phase:'active',billingMode:'standby',handoffId:null,generation:binding.generation+1});
    return {cancelled:true,operationId,cloudStandby:true};
  }
  async function cancelLocalPreparation(){
    if(supervisor.nodeRole!=='local-server')throw Error('Local cancellation required.');
    const config=await configuration(supervisor),latest=await json(path.join(config.directory,'current.json')),p=await read(latest.operationId),{state}=p,binding=await current();
    if(!(await status(state.operationId)).canResumeOriginal)throw Error('Recovery installation already began; inspect the active database before resuming.');
    if(binding.activationId!==state.sourceActivationId||binding.billingMode!=='standby'||binding.phase!=='validating'||binding.handoffId!==state.operationId)throw Error('Preparation already activated a candidate or changed ownership.');
    state.state='cancelled';state.pendingPeerCancel=true;await record(p,state);
    try{await cancelPeer(config,state.operationId);state.pendingPeerCancel=false;await record(p,state);}catch{}
    return {cancelled:true,peerCancellationPending:state.pendingPeerCancel};
  }
  async function finishCancellation(){
    if(supervisor.nodeRole!=='local-server')throw Error('Finish cancellation on local.');
    const config=await configuration(supervisor),latest=await json(path.join(config.directory,'current.json')),p=await read(latest.operationId),{state}=p,binding=await current();
    if(state.state!=='cancelled'||binding.activationId!==state.sourceActivationId)throw Error('This cancellation no longer belongs to the original local database.');
    if(state.pendingPeerCancel){await cancelPeer(config,state.operationId);state.pendingPeerCancel=false;await record(p,state);}
    return {cancelled:true,peerCancellationPending:false,localBillingUnchanged:true};
  }
  async function prepare({acknowledgeLostLocal=false,record:notify=async()=>{}}={}){
    if(supervisor.nodeRole!=='local-server')throw Error('Start preparation on local.');
    const config=await configuration(supervisor);const selectedMode=acknowledgeLostLocal?'lost-local-copy':'verified-copy';if(!config.allowedModes.includes(selectedMode))throw Error('Recovery mode is not permitted.');config.mode=selectedMode;
    await fs.mkdir(config.directory,{recursive:true,mode:0o700});
    let operationId;try{operationId=(await json(path.join(config.directory,'current.json'))).operationId;}catch(error){if(error.code!=='ENOENT')throw error;}
    if(operationId){
      const previous=await read(operationId);
      if(previous.state.state==='cancelled'){
        if(previous.state.pendingPeerCancel){await cancelPeer(config,operationId);previous.state.pendingPeerCancel=false;await record(previous,previous.state);}
        operationId=null;
      }
    }
    if(operationId){
      let previous;try{previous=await json(path.join(supervisor.directory,'baseline-node.json'));}catch(error){if(error.code!=='ENOENT')throw error;}
      if(previous?.operationId===operationId&&previous.state==='complete')operationId=null;
    }
    if(!operationId)operationId=crypto.randomUUID();const p=await paths(operationId);await fs.mkdir(p.directory,{recursive:true,mode:0o700});
    p.config.mode=selectedMode;
    let state;try{state=await json(p.job);}catch(error){if(error.code!=='ENOENT')throw error;}
    if(state&&state.mode!==selectedMode)throw Error('Recovery mode cannot change during an operation. Continue the original operation.');
    if(!state){const binding=await pause(operationId);state={operationId,shopId:supervisor.shopId,sourceActivationId:binding.activationId,mode:config.mode,state:'paused'};await record(p,state);}
    if(state.state==='prepared-disabled')return {operationId,prepared:true,mode:config.mode};
    const held=await current();if(held.activationId!==state.sourceActivationId||held.handoffId!==operationId||held.phase!=='validating'||held.billingMode!=='standby')throw Error('Local recovery hold changed. No candidate was activated.');
    await notify('preparing-cloud-snapshot');
    let remote=await peer(config,'/'+operationId).catch(()=>null);
    if(!remote?.metadata){await peer(config,'',{action:'export',operationId,mode:selectedMode});const end=Date.now()+(config.timeoutMs||30*60*1000);while(Date.now()<end){await new Promise(resolve=>setTimeout(resolve,1000));remote=await peer(config,'/'+operationId);if(remote.metadata)break;}if(!remote?.metadata)throw Error('Cloud preparation did not finish; both sources remain paused.');}
    const metadata=validateMetadata(remote.metadata,config,operationId);
    const artifactDirectory=path.join(p.directory,'artifact');await fs.mkdir(artifactDirectory,{recursive:true,mode:0o700});const sql=path.join(artifactDirectory,'database.sql');
    if(!state.downloaded){
      await notify('downloading-cloud-snapshot');await space(p.directory,metadata.manifest.sqlBytes*3);
      const pending=path.join(artifactDirectory,'database.sql.'+crypto.randomUUID()+'.pending');
      const response=await fetch(config.peer.url+'/'+operationId+'/artifact',{redirect:'error',signal:AbortSignal.timeout(config.timeoutMs||30*60*1000),headers:{Authorization:'Bearer '+config.peer.token}});
      if(!response.ok||!response.body){await response.body?.cancel();throw Error('Cloud snapshot download failed.');}
      await receiveArtifact(Readable.fromWeb(response.body),pending,metadata.manifest,config.maxBytes);
      await fs.rename(pending,sql);await atomic(path.join(artifactDirectory,'manifest.json'),metadata.manifest);state.downloaded=true;state.metadata=metadata;await record(p,state);
    }
    const digest=await digestFile(sql,config.maxBytes);if(digest.sha256!==metadata.manifest.sqlSha256||digest.bytes!==metadata.manifest.sqlBytes)throw Error('Retained cloud download changed.');
    await notify('preparing-local-copy');const prepared=await restoreCandidate(p,state,metadata);
    await notify('verifying-prepared-pair');remote=await peer(config,'',{action:'finalize',operationId,localDatabase:prepared.database.database});
    const final=validateMetadata(remote.metadata,config,operationId).report;
    if(final.state!=='prepared-disabled'||final.databases[0]!==prepared.database.database||final.baselineId!==prepared.report.baselineId||!final.prepared.every(Boolean))throw Error('Cloud did not confirm the prepared pair.');
    await writePlan(p,state,final,prepared.database);state.metadata={...metadata,report:final};state.state='prepared-disabled';await record(p,state);
    return {operationId,prepared:true,mode:config.mode};
  }
  return {prepare,export:exportCloud,status,artifact,finalize,cancelCloud,cancelLocalPreparation,finishCancellation};
}
module.exports={configuration,createRecoveryPreparation,digestFile,validateMetadata,checkSpace,receiveArtifact};
