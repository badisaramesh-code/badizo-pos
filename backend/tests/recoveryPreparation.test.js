const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto');
const {Readable}=require('node:stream');
const {atomic,json}=require('../services/recoveryControlFiles');
const {canonical}=require('../services/syncEventProtocol');
const {createRecoveryPreparation,validateMetadata,receiveArtifact,digestFile}=require('../services/recoveryPreparation');
const hash=value=>crypto.createHash('sha256').update(value).digest('hex');
async function fixture(t){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'badizo-preparation-'));
  t.after(async()=>{const resolved=path.resolve(root);assert.ok(resolved.startsWith(path.resolve(os.tmpdir())+path.sep)&&path.basename(resolved).startsWith('badizo-preparation-'));await fs.rm(resolved,{recursive:true,force:true});});
  const operationId=crypto.randomUUID(),directory=path.join(root,'jobs'),stateDirectory=path.join(directory,operationId);await fs.mkdir(stateDirectory,{recursive:true});
  const supervisor={shopId:'HFM001',nodeRole:'cloud-standby',directory:root,bindingPath:path.join(root,'binding.json'),preparationConfigPath:path.join(root,'config.json'),baselinePlanPath:path.join(root,'plan.json')};
  const config={schemaVersion:1,shopId:'HFM001',directory,incomingToken:'a'.repeat(64),baselineIncomingToken:'b'.repeat(64),mode:'lost-local-copy',maxBytes:10000,slots:[{restoreConfigPath:path.join(root,'slot.json')}],dumpExecutable:process.execPath,dumpDefaultsFile:path.join(root,'dump.cnf')};
  const binding={schemaVersion:1,shopId:'HFM001',activationId:crypto.randomUUID(),generation:1,phase:'active',billingMode:'active',database:{host:'127.0.0.1',user:'fixture',password:'private',database:'badizo_source'}};
  await atomic(supervisor.preparationConfigPath,config);await atomic(supervisor.bindingPath,binding);
  const report={operationId,shopId:'HFM001',businessFingerprint:{hash:'c'.repeat(64)},sqlSha256:'d'.repeat(64),sourceShopIdentityVerified:true,activationIds:[crypto.randomUUID(),crypto.randomUUID()],installationIds:['local-'+crypto.randomUUID(),'cloud-'+crypto.randomUUID()],databases:[null,'badizo_recovery_cloud0001']};
  report.baselineId=hash(canonical({shopId:config.shopId,sqlSha256:report.sqlSha256,businessHash:report.businessFingerprint.hash}));
  const metadata={operationId,shopId:'HFM001',mode:config.mode,sourceDatabase:'badizo_source',report,manifest:{shopId:'HFM001',sqlSha256:report.sqlSha256,sqlBytes:30,integrityVerified:true,shopIdentityVerified:true}};
  return {root,supervisor,config,binding,operationId,stateDirectory,metadata};
}
test('cloud metadata must bind shop, operation, hash and bounded SQL size',async t=>{
  const f=await fixture(t);assert.equal(validateMetadata(f.metadata,f.config,f.operationId),f.metadata);
  for(const change of [v=>v.shopId='HFM002',v=>v.operationId=crypto.randomUUID(),v=>v.manifest.sqlBytes=10001,v=>v.manifest.sqlSha256='e'.repeat(64),v=>v.report.businessFingerprint.hash='e'.repeat(64),v=>v.manifest.shopIdentityVerified=false]){
    const bad=structuredClone(f.metadata);change(bad);assert.throws(()=>validateMetadata(bad,f.config,f.operationId));
  }
});
test('streamed artifacts reject truncation, checksum changes and oversized content',async t=>{
  const f=await fixture(t),sql=Buffer.from('verified SQL bytes'),manifest={sqlBytes:sql.length,sqlSha256:hash(sql)};
  await receiveArtifact(Readable.from([sql]),path.join(f.root,'valid.pending'),manifest,1000);
  assert.equal((await digestFile(path.join(f.root,'valid.pending'),1000)).sha256,manifest.sqlSha256);
  for(const [name,bytes,limit] of [['truncated',sql.subarray(1),1000],['changed',Buffer.alloc(sql.length),1000],['oversized',Buffer.concat([sql,sql]),1000],['limit',sql,1]]){
    await assert.rejects(receiveArtifact(Readable.from([bytes]),path.join(f.root,name+'.pending'),manifest,limit));
  }
});
test('source advancement or lost billing hold prevents publishing prepared metadata',async t=>{
  for(const mode of ['changed','hold']){
    const f=await fixture(t);let calls=0;
    const service=createRecoveryPreparation(f.supervisor,{waitReady:async()=>{},space:async()=>{},inspect:async()=>{
      calls++;if(calls===2&&mode==='hold')await atomic(f.supervisor.bindingPath,{...await json(f.supervisor.bindingPath),phase:'active',billingMode:'active'});
      return {identity:{shopId:'HFM001'},fingerprint:{hash:calls===2&&mode==='changed'?'d'.repeat(64):'c'.repeat(64)}};
    },exportSql:async(_config,_binding,file,onSpawn)=>{await onSpawn(2147483647);await fs.writeFile(file,'SQL\n-- Dump completed');}});
    await assert.rejects(service.export(f.operationId),mode==='changed'?/Source|source changed/:/hold was lost/);
    const state=await json(path.join(f.stateDirectory,'preparation.json'));assert.equal(state.metadata,undefined);assert.equal(state.prepared,undefined);
  }
});
test('interrupted export retains the partial artifact and starts a fresh attempt only after old process is absent',async t=>{
  const f=await fixture(t);let attempts=0;
  const service=createRecoveryPreparation(f.supervisor,{waitReady:async()=>{},space:async()=>{},inspect:async()=>({identity:{shopId:'HFM001'},fingerprint:{hash:'c'.repeat(64)}}),exportSql:async(_config,_binding,file,onSpawn)=>{
    await onSpawn(2147483647);await fs.writeFile(file,'attempt '+(++attempts),{flag:'wx'});throw Error('interrupted attempt');
  }});
  await assert.rejects(service.export(f.operationId),/interrupted attempt/);
  await assert.rejects(service.export(f.operationId),/interrupted attempt/);
  assert.equal(attempts,2);
  const files=await fs.readdir(path.join(f.stateDirectory,'artifact'));assert.equal(files.filter(file=>file.includes('.partial-')).length,1);
});
test('stale finalization cannot replace a newer incident plan',async t=>{
  const f=await fixture(t),state={operationId:f.operationId,sourceActivationId:f.binding.activationId,prepared:true,state:'candidate-prepared',metadata:f.metadata};
  await atomic(path.join(f.stateDirectory,'preparation.json'),state);await atomic(path.join(f.config.directory,'current.json'),{operationId:crypto.randomUUID()});
  await atomic(f.supervisor.baselinePlanPath,{sentinel:'newer-plan'});
  await assert.rejects(createRecoveryPreparation(f.supervisor).finalize(f.operationId,'badizo_recovery_local0001'),/newer recovery/);
  assert.deepEqual(await json(f.supervisor.baselinePlanPath),{sentinel:'newer-plan'});
});
test('finalized cloud plan preserves the explicitly selected lost-source mode rather than config default',async t=>{
  const f=await fixture(t);await atomic(f.supervisor.preparationConfigPath,{...f.config,mode:'verified-copy'});
  await atomic(f.supervisor.bindingPath,{...f.binding,phase:'validating',billingMode:'standby',handoffId:f.operationId});
  const slot={host:'127.0.0.1',user:'fixture',password:'private',database:'badizo_recovery_cloud0001'};await atomic(f.config.slots[0].restoreConfigPath,slot);
  const state={operationId:f.operationId,mode:'lost-local-copy',sourceActivationId:f.binding.activationId,slot:{restoreConfigPath:f.config.slots[0].restoreConfigPath},prepared:true,state:'candidate-prepared',metadata:f.metadata};
  await atomic(path.join(f.stateDirectory,'preparation.json'),state);await atomic(path.join(f.config.directory,'current.json'),{operationId:f.operationId});
  await createRecoveryPreparation(f.supervisor).finalize(f.operationId,'badizo_recovery_local0001');
  assert.equal((await json(f.supervisor.baselinePlanPath)).mode,'lost-local-copy');
});
test('preparation transport authenticates before parsing and deduplicates only the same operation and mode',async t=>{
  const f=await fixture(t),express=require('express'),{createRouter}=require('../routes/recoveryPreparation');
  let queued=0;const control={status:async()=>({generation:1,operation:{kind:'prepare-export',state:'running',handoffId:f.operationId,mode:'lost-local-copy'}}),request:async()=>{queued++;return {state:'queued'};}};
  const configPath=path.join(f.root,'supervisor.json');await atomic(configPath,f.supervisor);
  const app=express();app.use('/api/recovery-preparation',createRouter({configPath,control}));
  const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
  t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});
  const url='http://127.0.0.1:'+server.address().port+'/api/recovery-preparation';
  assert.equal((await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:'x'.repeat(10000)})).status,401);
  const post=body=>fetch(url,{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+f.config.incomingToken},body:JSON.stringify(body)});
  assert.equal((await post({action:'export',operationId:f.operationId,mode:'lost-local-copy'})).status,202);
  assert.equal((await post({action:'export',operationId:crypto.randomUUID(),mode:'lost-local-copy'})).status,409);
  assert.equal((await post({action:'export',operationId:f.operationId,mode:'verified-copy'})).status,409);
  assert.equal(queued,0);
});
test('cancelled preparation retains original cloud standby and cannot cancel an installed candidate',async t=>{
  const f=await fixture(t),state={operationId:f.operationId,mode:'lost-local-copy',sourceActivationId:f.binding.activationId,prepared:true,state:'candidate-prepared',metadata:f.metadata};
  await atomic(path.join(f.stateDirectory,'preparation.json'),state);await atomic(path.join(f.config.directory,'current.json'),{operationId:f.operationId});
  await atomic(f.supervisor.bindingPath,{...f.binding,phase:'validating',billingMode:'standby',handoffId:f.operationId});
  const service=createRecoveryPreparation(f.supervisor);await service.cancelCloud(f.operationId);
  const binding=await json(f.supervisor.bindingPath);assert.equal(binding.activationId,f.binding.activationId);assert.equal(binding.billingMode,'standby');assert.equal(binding.phase,'active');assert.equal(binding.handoffId,null);
  assert.equal((await json(path.join(f.stateDirectory,'preparation.json'))).state,'cancelled');
  await atomic(f.supervisor.bindingPath,{...binding,activationId:f.metadata.report.activationIds[1]});
  await assert.rejects(service.cancelCloud(f.operationId),/advanced/);
});
test('finishing deferred peer cancellation never pauses local billing and clears pending only after acknowledgement',async t=>{
  const f=await fixture(t);f.supervisor.nodeRole='local-server';
  await atomic(f.supervisor.preparationConfigPath,{...f.config,peer:{url:'https://recovery.invalid/api/recovery-preparation',token:'c'.repeat(64),baselineToken:'d'.repeat(64)}});
  const state={operationId:f.operationId,sourceActivationId:f.binding.activationId,mode:'lost-local-copy',state:'cancelled',pendingPeerCancel:true};
  await atomic(path.join(f.stateDirectory,'preparation.json'),state);await atomic(path.join(f.config.directory,'current.json'),{operationId:f.operationId});
  let available=false;
  t.mock.method(globalThis,'fetch',async(_url,options)=>{assert.deepEqual(JSON.parse(options.body),{action:'cancel',operationId:f.operationId});return new Response(JSON.stringify({cancelled:true,operationId:f.operationId,cloudStandby:true}),{status:available?200:503});});
  const service=createRecoveryPreparation(f.supervisor);
  await assert.rejects(service.finishCancellation(),/unavailable/);
  assert.equal((await json(path.join(f.stateDirectory,'preparation.json'))).pendingPeerCancel,true);assert.deepEqual(await json(f.supervisor.bindingPath),f.binding);
  available=true;assert.equal((await service.finishCancellation()).peerCancellationPending,false);
  assert.equal((await json(path.join(f.stateDirectory,'preparation.json'))).pendingPeerCancel,false);assert.deepEqual(await json(f.supervisor.bindingPath),f.binding);
});
test('completed pair preparation cannot offer original-local cancellation before a cloud activation journal is visible locally',async t=>{
  const f=await fixture(t);f.supervisor.nodeRole='local-server';
  await atomic(f.supervisor.preparationConfigPath,{...f.config,peer:{url:'https://recovery.invalid/api/recovery-preparation',token:'c'.repeat(64),baselineToken:'d'.repeat(64)}});
  await atomic(f.supervisor.bindingPath,{...f.binding,phase:'validating',billingMode:'standby',handoffId:f.operationId});
  const state={operationId:f.operationId,sourceActivationId:f.binding.activationId,mode:'lost-local-copy',state:'candidate-prepared'};
  await atomic(path.join(f.stateDirectory,'preparation.json'),state);await atomic(path.join(f.config.directory,'current.json'),{operationId:f.operationId});
  const service=createRecoveryPreparation(f.supervisor);assert.equal((await service.status()).canResumeOriginal,true);
  await atomic(path.join(f.stateDirectory,'preparation.json'),{...state,state:'prepared-disabled'});
  assert.equal((await service.status()).canResumeOriginal,false);
  await assert.rejects(service.cancelLocalPreparation(),/already began/);
});
