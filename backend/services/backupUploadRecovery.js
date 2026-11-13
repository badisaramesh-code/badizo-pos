'use strict';
const fs = require('node:fs/promises');
const nativeFs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { atomic, json, shareStateHandle } = require('./recoveryControlFiles');
const { validate } = require('./recoveryRuntimeBinding');
const { prepareRecoveryBackup } = require('./recoveryBackupArtifact');
const uuid = value => /^[a-f0-9-]{36}$/.test(value || '');
const sha = value => /^[a-f0-9]{64}$/.test(value || '');
const phrase = 'REPLACE WITH UPLOADED BACKUP AND START BILLING';

async function configuration(supervisor) {
  if (!path.isAbsolute(supervisor.uploadRecoveryConfigPath || '')) throw Error('Backup upload recovery has not been provisioned.');
  const c = await json(supervisor.uploadRecoveryConfigPath);
  if (c.schemaVersion !== 1 || c.shopId !== supervisor.shopId || !path.isAbsolute(c.directory || '') || !path.isAbsolute(c.databaseDataDirectory||'') ||
      !Array.isArray(c.slots) || !c.slots.length || c.slots.length > 20 ||
      c.slots.some(slot => !path.isAbsolute(slot.restoreConfigPath || '')) ||
      !Number.isSafeInteger(c.maxUploadBytes) || c.maxUploadBytes < 1024 || c.maxUploadBytes > 2 * 1024 ** 3 ||
      !Number.isSafeInteger(c.maxExpandedBytes) || c.maxExpandedBytes < c.maxUploadBytes || c.maxExpandedBytes > 20 * 1024 ** 3 ||
      !c.expectedShop || typeof c.expectedShop.gstNumber !== 'string' || !c.expectedShop.gstNumber.trim()) throw Error('Invalid protected backup recovery configuration.');
  c.maxSpoolBytes=c.maxSpoolBytes||Math.max(64*1024**2,c.maxExpandedBytes*3);
  c.maxStoredUploads=c.maxStoredUploads||20;
  if(!Number.isSafeInteger(c.maxSpoolBytes)||c.maxSpoolBytes<c.maxUploadBytes+c.maxExpandedBytes||c.maxSpoolBytes>100*1024**3||
    !Number.isInteger(c.maxStoredUploads)||c.maxStoredUploads<1||c.maxStoredUploads>100)throw Error('Invalid recovery spool quota.');
  return c;
}
async function spoolUsage(directory){
  let bytes=0,files=0,jobs=0;
  async function visit(root){
    for(const entry of await fs.readdir(root,{withFileTypes:true})){
      const file=path.join(root,entry.name),stat=await fs.lstat(file);
      if(stat.isSymbolicLink())throw Error('Recovery spool links require inspection.');
      if(stat.isDirectory()){if(root===directory&&uuid(entry.name))jobs++;await visit(file);}
      else if(stat.isFile()){if(++files>20000)throw Error('Recovery spool requires maintenance.');bytes+=stat.size;}
      else throw Error('Unsupported recovery spool entry.');
    }
  }
  await visit(directory);return {bytes,jobs};
}
function uploadPath(c, id) {
  if (!uuid(id)) throw Error('Invalid backup upload identity.');
  return path.join(c.directory, id);
}
async function sourceDatabaseFromDump(file,approved='badizo_pos'){
  let head='';
  const stream=nativeFs.createReadStream(file,{end:262143});
  for await(const chunk of stream)head+=chunk.toString('utf8');
  const names=new Set();
  for(const line of head.split(/\r?\n/)){
    const match=line.match(/^USE `([A-Za-z0-9_]+)`;\s*$/)||line.match(/^CREATE DATABASE \/\*!32312 IF NOT EXISTS\*\/ `([A-Za-z0-9_]+)` /);
    if(match)names.add(match[1]);
  }
  if(names.size>1)throw Error('A single POS database backup is required.');
  const source=names.size?[...names][0]:approved;
  if(source!==approved&&!/^badizo_recovery_[a-z0-9]{8,32}$/.test(source))throw Error('Backup database name is not an approved POS or recovery namespace.');
  return source;
}
function publicJob(job) {
  if (!job) return null;
  return { id: job.id, filename: job.filename, sourceBytes: job.sourceBytes, uploadedAt: job.uploadedAt,
    backupTime: job.backupTime || null, state: job.state, actor: job.actor, message: job.message || null,
    operationId: job.operationId || null, result: job.result ? { products: job.result.products, invoices: job.result.invoices,
      tableCount: job.result.tableCount, activated: job.result.activated === true } : null };
}
async function activationHistory(c){
  try{
    const value=await json(path.join(c.directory,'activation-history.json'));
    if(value.schemaVersion!==1||value.shopId!==c.shopId||!uuid(value.operationId)||!uuid(value.activationId))throw Error('Recovery activation history needs inspection.');
    return value;
  }catch(error){if(error.code==='ENOENT')return null;throw error;}
}
async function markRecoveryActivated(c,request,binding){
  const existing=await activationHistory(c);
  if(existing){
    if(existing.operationId!==request.id||existing.activationId!==binding.activationId)throw Error('Previous recovery history must be reviewed before replacing this node.');
    return;
  }
  const file=await fs.open(path.join(c.directory,'activation-history.json'),'wx',0o600);
  try{await file.writeFile(JSON.stringify({schemaVersion:1,shopId:c.shopId,operationId:request.id,activationId:binding.activationId,generation:binding.generation,activatedAt:new Date().toISOString()}));await shareStateHandle(path.join(c.directory,'activation-history.json'),file);await file.sync();}
  finally{await file.close();}
}
function createBackupUploadRecovery(supervisor) {
  if(!['local-server','cloud-standby','cloud-active'].includes(supervisor?.nodeRole)||!path.isAbsolute(supervisor.directory||'')||
    !path.isAbsolute(supervisor.bindingPath||'')||!/^[A-Z][A-Z0-9_-]{2,31}$/.test(supervisor.shopId||''))throw Error('Explicit protected node recovery configuration required.');
  async function status() {
    const c = await configuration(supervisor);
    const binding = validate(await json(supervisor.bindingPath), supervisor.shopId);
    let heartbeat;
    try { heartbeat = await json(path.join(supervisor.directory, 'heartbeat.json')); } catch {}
    let job = null;
    try {
      const current = await json(path.join(c.directory, 'current.json'));
      job = await json(path.join(uploadPath(c, current.id), 'upload.json'));
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    let pending=null;try{pending=await json(path.join(supervisor.directory,'request.json'));}catch(error){if(error.code!=='ENOENT')throw error;}
    const shownJob=pending?.kind==='recover-upload'&&pending.uploadId===job?.id&&job.state==='uploaded'?{...job,state:'queued',operationId:pending.id}:job;
    const history=await activationHistory(c);
    const canReplace=!pending&&!history&&!binding.backupRecoveryOperationId && binding.phase === 'active' && (binding.billingMode === 'standby' ||supervisor.nodeRole === 'local-server');
    const heartbeatAge=Date.now()-Date.parse(heartbeat?.at);
    return { configured: true, nodeRole: supervisor.nodeRole, generation: binding.generation,
      phase: binding.phase, billingMode: binding.billingMode,
      supervisorOnline: heartbeat?.shopId === supervisor.shopId && Number.isFinite(heartbeatAge)&&heartbeatAge>=-5000&&heartbeatAge<15000,
      maxUploadBytes: c.maxUploadBytes, job: publicJob(shownJob),
      canReplace,requiresReviewedRebaseline:!!history||!!binding.backupRecoveryOperationId,
      canUpload:canReplace&&(!job||['complete','failed','discarded'].includes(job.state)) };
  }
  async function receive(stream, { filename, actor, length }) {
    const c = await configuration(supervisor);
    if (typeof actor !== 'string' || !actor.trim() || typeof filename !== 'string' || filename !== path.basename(filename) ||
        filename.includes('\\') || !/^[A-Za-z0-9 _().-]{1,180}\.sql(?:\.gz)?$/i.test(filename)) throw Error('Choose a SQL or SQL.GZ backup.');
    if (length != null && (!Number.isSafeInteger(length) || length <= 0 || length > c.maxUploadBytes)) throw Error('Backup upload exceeds the configured limit.');
    const state = await status();
    if (!state.supervisorOnline || !state.canReplace) throw Error('The recovery supervisor must be online and cloud billing must remain in standby.');
    await fs.mkdir(c.directory, { recursive: true, mode: 0o700 });
    const guard=await fs.open(path.join(c.directory,'incoming.lock'),'wx',0o600);
    try{
    const latest=await status();
    if(!latest.canUpload)throw Error('A backup upload or recovery is already pending.');
    const usage=await spoolUsage(c.directory);
    if(usage.jobs>=c.maxStoredUploads||usage.bytes+(length||c.maxUploadBytes)+c.maxExpandedBytes>c.maxSpoolBytes)throw Error('Recovery spool quota reached. Retained evidence must be reviewed before another upload.');
    const space = await fs.statfs(c.directory);
    if (Number(space.bavail) * Number(space.bsize) < c.maxExpandedBytes * 2 + (length || c.maxUploadBytes)) throw Error('Insufficient recovery disk space.');
    const id = crypto.randomUUID(), directory = uploadPath(c, id);
    await fs.mkdir(directory, { mode: 0o700 });
    const input = path.join(directory, filename.toLowerCase().endsWith('.gz') ? 'backup.sql.gz' : 'backup.sql');
    const pending = input + '.pending', digest = crypto.createHash('sha256'); let bytes = 0;
    const meter = new Transform({ transform(chunk, _encoding, callback) {
      bytes += chunk.length;
      if (bytes > c.maxUploadBytes) return callback(Error('Backup upload exceeds the configured limit.'));
      digest.update(chunk); callback(null, chunk);
    } });
    const timeout = setTimeout(() => stream.destroy(Error('Backup upload timed out.')), 15 * 60 * 1000);
    try {
      await pipeline(stream, meter, nativeFs.createWriteStream(pending, { flags: 'wx', mode: 0o600 }));
      if (!bytes || length != null && bytes !== length) throw Error('Backup upload was incomplete.');
      const handle = await fs.open(pending, 'r+'); try { await handle.sync(); } finally { await handle.close(); }
      await fs.rename(pending, input);
      const job = { id, shopId: supervisor.shopId, filename, actor, sourceBytes: bytes, sourceSha256: digest.digest('hex'),
        input, state: 'uploaded', uploadedAt: new Date().toISOString(), activated: false };
      await atomic(path.join(directory, 'upload.json'), job);
      await atomic(path.join(c.directory, 'current.json'), { id });
      return publicJob(job);
    } catch (error) { await fs.unlink(pending).catch(() => {}); throw error; }
    finally { clearTimeout(timeout); }
    }finally{await guard.close();await fs.unlink(path.join(c.directory,'incoming.lock'));}
  }
  async function discard(id,actor){
    const c=await configuration(supervisor),guard=await fs.open(path.join(c.directory,'incoming.lock'),'wx',0o600);
    try{
    const state=await status();
    if(!state.canReplace||state.job?.id!==id||state.job.state!=='uploaded'||!actor)throw Error('Only an unqueued upload can be set aside.');
    const file=path.join(uploadPath(c,id),'upload.json'),job=await json(file);
    await atomic(file,{...job,state:'discarded',discardedBy:actor,discardedAt:new Date().toISOString()});
    return publicJob({...job,state:'discarded'});
    }finally{await guard.close();await fs.unlink(path.join(c.directory,'incoming.lock'));}
  }
  async function request(value, actor) {
    if (typeof actor!=='string'||!actor.trim()||actor.length>100||!value || Object.keys(value).sort().join(',') !== 'backupAgeAccepted,confirmation,expectedGeneration,peerBillingStopped,uploadId' ||
        value.confirmation !== phrase || value.peerBillingStopped !== true || value.backupAgeAccepted !== true ||
        !uuid(value.uploadId) || !Number.isSafeInteger(value.expectedGeneration)) throw Error('Confirm the backup age, replacement and that the other server cannot bill.');
    const c = await configuration(supervisor),guard=await fs.open(path.join(c.directory,'incoming.lock'),'wx',0o600);
    try{
    const state=await status();
    if (!state.supervisorOnline || !state.canReplace || value.expectedGeneration !== state.generation) throw Error('Billing state changed or recovery is unavailable.');
    const directory = uploadPath(c, value.uploadId), job = await json(path.join(directory, 'upload.json'));
    if (job.shopId !== supervisor.shopId || job.state !== 'uploaded' || !sha(job.sourceSha256)) throw Error('Select a new complete upload.');
    const request = { id: crypto.randomUUID(), kind: 'recover-upload', shopId: supervisor.shopId, uploadId: job.id,
      actor, expectedGeneration: value.expectedGeneration, requestedAt: new Date().toISOString(),
      peerBillingStopped: true, backupAgeAccepted: true };
    const staged=path.join(supervisor.directory,'upload-request-'+request.id+'.tmp');
    const file=await fs.open(staged,'wx',0o600);
    try{await file.writeFile(JSON.stringify(request));await file.sync();}finally{await file.close();}
    try{await fs.link(staged,path.join(supervisor.directory,'request.json'));}finally{await fs.unlink(staged);}
    return { id: request.id, state: 'queued' };
    }finally{await guard.close();await fs.unlink(path.join(c.directory,'incoming.lock'));}
  }
  return { status, receive, request,discard };
}

async function reserveSlot(c, binding, operationId, checkEmpty) {
  for (const entry of c.slots) {
    const slot = await json(entry.restoreConfigPath);
    if (slot.shopId !== c.shopId || !/^badizo_recovery_[a-z0-9]{8,32}$/.test(slot.database || '') ||
        !['localhost', '127.0.0.1'].includes(slot.host) || (slot.port!==undefined&&(!Number.isInteger(slot.port)||slot.port<1||slot.port>65535)) || slot.database === binding.database.database) throw Error('Invalid detached recovery slot.');
    try {
      const handle = await fs.open(path.join(c.directory, slot.database + '.reservation'), 'wx', 0o600);
      try { await handle.writeFile(operationId); await handle.sync(); } finally { await handle.close(); }
    } catch (error) { if (error.code === 'EEXIST') continue; throw error; }
    if (!await checkEmpty(slot)) throw Error('Reserved recovery slot was not empty; preserve it for inspection.');
    return slot;
  }
  throw Error('No unused recovery slot is available. Existing databases were retained.');
}

async function executeBackupUploadRecovery(supervisor, request, adapters) {
  const c = await configuration(supervisor), directory = uploadPath(c, request.uploadId);
  const file = path.join(directory, 'upload.json'), job = await json(file);
  const old = validate(await json(supervisor.bindingPath), supervisor.shopId);
  if (request.shopId !== c.shopId || job.shopId !== c.shopId || job.state !== 'uploaded' ||old.backupRecoveryOperationId||await activationHistory(c)||
      old.generation !== request.expectedGeneration || old.phase !== 'active' || request.peerBillingStopped !== true ||
      request.backupAgeAccepted !== true || (supervisor.nodeRole !== 'local-server' || old.backupRecoveryOperationId) && old.billingMode !== 'standby') throw Error('Uploaded recovery no longer matches a stopped target and source.');
  let committed = false, releaseCandidateFence = null;
  async function record(state, extra = {}) {
    Object.assign(job, { state, operationId: request.id, ...extra });
    await atomic(file, job);
    await atomic(path.join(supervisor.directory, 'operation.json'), { id: request.id, kind: request.kind,
      actor: request.actor, shopId: c.shopId, state, uploadId: job.id, updatedAt: new Date().toISOString() });
  }
  // Restart recovery never repeats an import: non-uploaded jobs remain held for inspection.
  await record('pausing');
  await atomic(supervisor.bindingPath, { ...old, phase: 'validating', billingMode: 'standby', nativeReplicationInvalidated: true });
  try {
    await adapters.waitReady(old.activationId, { drained: true });
    if (c.nativeReplicationDirectory) {
      if (!path.isAbsolute(c.nativeReplicationDirectory)) throw Error('Invalid native replication directory.');
      await atomic(path.join(c.nativeReplicationDirectory, 'native-invalidation.json'), { schemaVersion: 1,
        operationId: request.id, reason: 'backup-upload-restore', invalidatedAt: new Date().toISOString(), previousActivationId: old.activationId });
    }
    if (typeof adapters.withRecoveryFence !== 'function') throw Error('The installed recovery/replication fence is unavailable.');
    return await adapters.withRecoveryFence(c, request, async () => {
      const slot = await reserveSlot(c, old, request.id, adapters.checkEmpty);
      await record('preparing');
      const artifactDirectory = path.join(directory, 'artifact');
      const artifact=await prepareRecoveryBackup({ sourcePath: job.input, outputDirectory: artifactDirectory,
        expectedSha256: job.sourceSha256, shopId: c.shopId, source: supervisor.nodeRole === 'local-server' ? 'cloud-export' : 'google-drive', maxExpandedBytes: c.maxExpandedBytes,requireCompleteDump:true });
      job.backupTime=artifact.reportedBackupTime;
      const dataSpace=await fs.statfs(c.databaseDataDirectory);
      if(Number(dataSpace.bavail)*Number(dataSpace.bsize)<artifact.sqlBytes*4+512*1024**2)throw Error('Insufficient space on the MySQL data volume. No SQL imported.');
      const sourceDatabase=await sourceDatabaseFromDump(path.join(artifactDirectory,'database.sql'),slot.sourceDatabase||'badizo_pos');
      const restoreConfig = { ...slot, artifactDirectory,sourceDatabase };
      const restoreConfigPath = path.join(directory, 'restore-config.json'); await atomic(restoreConfigPath, restoreConfig);
      await record('restoring');
      const result = await adapters.restore(restoreConfigPath);
      if (result.shopId !== c.shopId || result.database !== slot.database || result.stagedRestoreVerified !== true || result.activated !== false||
        !['tableCount','products','invoices'].every(key=>Number.isSafeInteger(result[key])&&result[key]>=0)) throw Error('Detached restore did not verify.');
      if(typeof adapters.acquireDatabaseFence!=='function')throw Error('Candidate reconstruction fence is unavailable.');
      releaseCandidateFence=await adapters.acquireDatabaseFence({database:{host:slot.host,port:slot.port||3306,user:slot.user,password:slot.password,database:slot.database}});
      await adapters.validateCandidate(restoreConfig, c.expectedShop, result);
      if (typeof adapters.prepareInvoiceNumbers !== 'function') throw Error('Recovery invoice-number protection has not been installed.');
      const numbering = await adapters.prepareInvoiceNumbers({ candidateDatabase: restoreConfig, previousDatabase: old.database,
        nodeRole: supervisor.nodeRole, operationId: request.id });
      if (numbering?.invoiceNumbersVerified !== true || !numbering.invoiceEpoch) throw Error('Recovery invoice-number protection did not verify.');
      const candidate = validate({ ...old, database: { host: slot.host,port:slot.port||3306, user: slot.user, password: slot.password, database: slot.database },
        activationId: crypto.randomUUID(), generation: old.generation + 1, phase: 'validating', billingMode: 'active',
        reconciliationRequired: true, nativeReplicationInvalidated: true, invoiceEpoch: numbering.invoiceEpoch,
        backupRecoveryOperationId:request.id }, c.shopId);
      await adapters.verify(candidate,result);
      await record('starting', { targetActivationId: candidate.activationId, result: { tableCount: result.tableCount, products: result.products, invoices: result.invoices, activated: false } });
      await atomic(path.join(directory, 'previous-binding.json'), old);
      await adapters.runCommand(supervisor.stop);
      await atomic(supervisor.bindingPath, candidate);
      await adapters.runCommand(supervisor.start);
      await adapters.waitReady(candidate.activationId);
      await atomic(supervisor.bindingPath, { ...candidate, phase: 'active' }); committed = true;
      await markRecoveryActivated(c,request,candidate);
      await record('complete', { result: { ...job.result, activated: true }, message: 'Uploaded backup verified and billing activated. Previous database retained. Synchronization requires a new verified baseline.' });
      return { activated: true, activationId: candidate.activationId };
    });
  } catch (error) {
    if (committed||error.commitVerified===true) throw Object.assign(Error('Recovery activation may contain new sales. Preserve the journal; automatic rollback is prohibited.'),{recoveryCommitted:true});
    if(error.recoveryRequired===true){
      await record('inspection-required',{message:'Activation or native fencing outcome is unconfirmed. No automatic rollback was attempted. Preserve both databases and inspect authority before billing.'});
      throw error;
    }
    // Retain both databases and pause billing; rollback never enables an old writer.
    try {
      const current = validate(await json(supervisor.bindingPath), c.shopId);
      if (current.activationId !== old.activationId) {
        await adapters.runCommand(supervisor.stop);
        await atomic(supervisor.bindingPath, { ...old, phase: 'validating', billingMode: 'standby', nativeReplicationInvalidated: true });
        await adapters.runCommand(supervisor.start); await adapters.waitReady(old.activationId);
      }
      await atomic(supervisor.bindingPath, { ...old, phase: 'active', billingMode: 'standby', nativeReplicationInvalidated: true });
    } catch { await record('inspection-required', { message: 'Restore outcome is uncertain. Both databases were retained; do not start billing on both servers.' }); throw error; }
    await record('failed', { message: 'Restore did not activate. Previous database retained, billing paused, and synchronization invalidated. Inspect before retrying.' });
    throw error;
  }finally{if(releaseCandidateFence)await releaseCandidateFence();}
}
module.exports = { configuration, createBackupUploadRecovery, executeBackupUploadRecovery, reserveSlot, publicJob, phrase,spoolUsage,sourceDatabaseFromDump,activationHistory,markRecoveryActivated };
