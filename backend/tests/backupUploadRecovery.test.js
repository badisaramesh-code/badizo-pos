'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs/promises'), os = require('node:os'), path = require('node:path'), crypto = require('node:crypto');
const { Readable } = require('node:stream');
const { atomic, json } = require('../services/recoveryControlFiles');
const { createBackupUploadRecovery, executeBackupUploadRecovery, phrase,sourceDatabaseFromDump } = require('../services/backupUploadRecovery');
const { invoiceEpochForOperation } = require('../services/recoveryInvoiceNumbers');
const sql = Buffer.from('-- MySQL dump\nCREATE TABLE example(id INT);\n-- Dump completed on 2026-11-13 09:00:00\n');
async function setup(t, nodeRole = 'local-server') {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'badizo-upload-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const uploads = path.join(root, 'uploads'); await fs.mkdir(uploads);
  const config = { shopId: 'HFM001', nodeRole, directory: root, bindingPath: path.join(root, 'binding.json'), uploadRecoveryConfigPath: path.join(root, 'uploads-config.json') };
  const old = { schemaVersion: 1, shopId: 'HFM001', activationId: crypto.randomUUID(), generation: 0, phase: 'active', billingMode: nodeRole === 'local-server' ? 'active' : 'standby',
    database: { host: '127.0.0.1', user: 'runtime', password: 'private', database: 'old_pos' } };
  await atomic(config.bindingPath, old);
  await atomic(path.join(root, 'heartbeat.json'), { shopId: 'HFM001', at: new Date().toISOString() });
  const slotPath = path.join(root, 'slot.json');
  await atomic(slotPath, { shopId: 'HFM001', host: '127.0.0.1', user: 'scoped', password: 'private', database: 'badizo_recovery_12345678' });
  await atomic(config.uploadRecoveryConfigPath, { schemaVersion: 1, shopId: 'HFM001', directory: uploads,databaseDataDirectory:root, maxUploadBytes: 1024 * 1024, maxExpandedBytes: 2 * 1024 * 1024,
    expectedShop: { gstNumber: 'TESTGST' }, slots: [{ restoreConfigPath: slotPath }] });
  const service = createBackupUploadRecovery(config);
  const upload = async (body = sql, filename = 'daily.sql') => service.receive(Readable.from([body]), { filename, actor: 'owner', length: body.length });
  const request = async id => { await service.request({ uploadId: id, expectedGeneration: 0, confirmation: phrase, peerBillingStopped: true, backupAgeAccepted: true }, 'owner'); return json(path.join(root, 'request.json')); };
  return { root, uploads, config, old, service, upload, request };
}
test('upload is private, bounded and does not replace the active database', async t => {
  const f = await setup(t), uploaded = await f.upload();
  assert.equal(uploaded.state, 'uploaded'); assert.equal(uploaded.sourceBytes, sql.length);
  assert.equal(uploaded.input, undefined); assert.equal(uploaded.sourceSha256, undefined);
  assert.deepEqual(await json(f.config.bindingPath), f.old);
  await assert.rejects(f.upload(sql, '../escape.sql'));
  await assert.rejects(f.upload(Buffer.alloc(1024 * 1024 + 1)));
});
test('cloud backup replacement is refused after cloud billing is active', async t => {
  const f = await setup(t, 'cloud-standby');
  await atomic(f.config.bindingPath, { ...f.old, billingMode: 'active' });
  await assert.rejects(f.upload(), /standby/);
});
test('pausing a cloud that already activated recovery cannot reopen old-backup replacement',async t=>{
  const f=await setup(t,'cloud-standby');
  // A normal owner Pause Billing changes generation/mode, not the recovery lineage.
  await atomic(f.config.bindingPath,{...f.old,generation:4,billingMode:'standby',backupRecoveryOperationId:crypto.randomUUID()});
  const state=await f.service.status();
  assert.equal(state.canReplace,false);assert.equal(state.canUpload,false);assert.equal(state.requiresReviewedRebaseline,true);
  await assert.rejects(f.upload());
});
test('recovery requires explicit peer fencing, loss acceptance and fresh generation', async t => {
  const f = await setup(t), uploaded = await f.upload();
  const base = { uploadId: uploaded.id, expectedGeneration: 0, confirmation: phrase, peerBillingStopped: true, backupAgeAccepted: true };
  for (const patch of [{ peerBillingStopped: false }, { backupAgeAccepted: false }, { expectedGeneration: 9 }, { database: 'other' }]) await assert.rejects(f.service.request({ ...base, ...patch }, 'owner'));
  await f.request(uploaded.id);
  assert.equal((await f.service.status()).canReplace, false);
  await assert.rejects(f.upload(), /standby/);
});
for (const nodeRole of ['local-server', 'cloud-standby']) {
  test(nodeRole + ' switches only after detached restore, validation and readiness', async t => {
    const f = await setup(t, nodeRole), uploaded = await f.upload(), request = await f.request(uploaded.id), events = [];
    const adapters = {
      waitReady: async (_id, options) => { events.push(options?.drained ? 'drain' : 'ready'); },
      withRecoveryFence: async (_c, _r, operation) => { events.push('fence'); return operation(); },
      checkEmpty: async () => true,
      acquireDatabaseFence:async()=>async()=>{},
      restore: async filename => { const c = await json(filename); events.push('restore'); return { shopId: 'HFM001', database: c.database, stagedRestoreVerified: true, activated: false, tableCount: 10, products: 2, invoices: 3 }; },
      validateCandidate: async () => { events.push('validate'); },
      prepareInvoiceNumbers: async value => ({ invoiceNumbersVerified: true, invoiceEpoch: invoiceEpochForOperation(value.operationId) }),
      verify: async candidate => { assert.equal(candidate.phase, 'validating'); events.push('verify'); },
      runCommand: async value => { events.push(value); }
    };
    f.config.stop = 'stop'; f.config.start = 'start';
    const result = await executeBackupUploadRecovery(f.config, request, adapters);
    const active = await json(f.config.bindingPath);
    assert.equal(result.activated, true); assert.equal(active.billingMode, 'active'); assert.equal(active.phase, 'active');
    assert.equal(active.nativeReplicationInvalidated, true); assert.notEqual(active.activationId, f.old.activationId);
    assert.equal(active.invoiceEpoch, invoiceEpochForOperation(request.id));
    assert.deepEqual(events, ['drain', 'fence', 'restore', 'validate', 'verify', 'stop', 'start', 'ready']);
    assert.equal((await json(path.join(f.uploads, uploaded.id, 'previous-binding.json'))).database.database, 'old_pos');
    assert.equal((await f.service.status()).job.result.activated, true);
    assert.equal((await f.service.status()).canReplace,false);
    // Even if a later control path omits the binding marker, protected activation history blocks replacement.
    await atomic(f.config.bindingPath,{...f.old,generation:4,billingMode:'standby'});
    assert.equal((await f.service.status()).canReplace,false);
  });
}
test('failed candidate validation retains the old database and leaves billing paused', async t => {
  const f = await setup(t), uploaded = await f.upload(), request = await f.request(uploaded.id);
  await assert.rejects(executeBackupUploadRecovery(f.config, request, {
    waitReady: async () => {}, withRecoveryFence: async (_c, _r, run) => run(), checkEmpty: async () => true,
    restore: async () => { throw Error('invalid SQL'); }
  }));
  const binding = await json(f.config.bindingPath);
  assert.equal(binding.database.database, f.old.database.database); assert.equal(binding.billingMode, 'standby');
  assert.equal(binding.nativeReplicationInvalidated, true); assert.equal((await f.service.status()).job.state, 'failed');
  await fs.access(path.join(f.uploads, uploaded.id, 'backup.sql'));
});
test('native readonly cleanup uses exact durable commit proof, never generic exceptions',()=>{
  const {uploadedRecoveryCommitted}=require('../services/backupUploadRecoveryAdapters');
  const prior={activationId:crypto.randomUUID()},request={id:crypto.randomUUID(),expectedGeneration:3},target=crypto.randomUUID();
  const job={targetActivationId:target};
  const committed={activationId:target,backupRecoveryOperationId:request.id,generation:4,phase:'active',billingMode:'active',nativeReplicationInvalidated:true};
  assert.equal(uploadedRecoveryCommitted({prior,request,job,binding:committed}),true);
  assert.equal(uploadedRecoveryCommitted({prior,request,job,binding:{...committed,phase:'validating'}}),false);
  assert.equal(uploadedRecoveryCommitted({prior,request,job,binding:{activationId:prior.activationId,generation:3,phase:'validating',billingMode:'standby'}}),false);
  assert.throws(()=>uploadedRecoveryCommitted({prior,request,job,binding:{...committed,activationId:crypto.randomUUID()}}),/proof/);
  assert.throws(()=>uploadedRecoveryCommitted({prior,request,job,binding:{...committed,generation:5}}),/proof/);
});
test('one upload at a time and retained-evidence spool quotas are enforced',async t=>{
  const f=await setup(t);let started;
  const ready=new Promise(resolve=>{started=resolve;});
  const stream=new Readable({read(){started();}});
  const pending=f.service.receive(stream,{filename:'daily.sql',actor:'owner',length:sql.length});
  await ready;
  await assert.rejects(f.upload());
  stream.push(sql);stream.push(null);const first=await pending;
  await assert.rejects(f.upload(),/already pending/);
  await f.service.discard(first.id,'owner');
  const config=await json(f.config.uploadRecoveryConfigPath);config.maxSpoolBytes=config.maxUploadBytes+config.maxExpandedBytes;
  await atomic(f.config.uploadRecoveryConfigPath,config);
  await fs.writeFile(path.join(f.uploads,'retained-evidence'),Buffer.alloc(config.maxSpoolBytes));
  await assert.rejects(f.upload(),/quota/);
});
test('supervisor recovers a lost completion write without replaying SQL or rolling back new sales',async t=>{
  const f=await setup(t),uploaded=await f.upload(),request=await f.request(uploaded.id),target=crypto.randomUUID();
  const jobPath=path.join(f.uploads,uploaded.id,'upload.json'),job=await json(jobPath);
  await atomic(jobPath,{...job,state:'starting',operationId:request.id,targetActivationId:target,result:{products:2,invoices:3,tableCount:10,activated:false}});
  await atomic(f.config.bindingPath,{...f.old,activationId:target,generation:1,phase:'active',billingMode:'active'});
  const supervisor=require('../services/recoverySupervisor').createRecoverySupervisor({...f.config,restoreConfigPath:path.join(f.root,'unused.json'),restoreJobDirectory:f.root,readyUrl:'http://127.0.0.1:5009/api/ready'},
    {runCommand:async()=>{throw Error('A committed recovery must not restart again');}});
  await supervisor.tick();
  assert.equal((await json(jobPath)).state,'complete');assert.equal((await json(jobPath)).result.activated,true);
  assert.equal((await json(f.config.bindingPath)).activationId,target);
  await assert.rejects(fs.access(path.join(f.root,'request.json')));
});
test('a truncated dump never reaches SQL import', async t => {
  const f = await setup(t), uploaded = await f.upload(Buffer.from('CREATE TABLE partial(id INT);')), request = await f.request(uploaded.id);
  let imported = false;
  await assert.rejects(executeBackupUploadRecovery(f.config, request, { waitReady: async () => {}, withRecoveryFence: async (_c, _r, run) => run(),
    checkEmpty: async () => true, restore: async () => { imported = true; } }));
  assert.equal(imported, false);
});
test('return-to-local recognizes a prior recovery database header but rejects other databases',async t=>{
  const f=await setup(t),file=path.join(f.root,'header.sql');
  await fs.writeFile(file,'CREATE DATABASE /*!32312 IF NOT EXISTS*/ `badizo_recovery_12345678` /*!40100 DEFAULT CHARACTER SET utf8mb4 */;\nUSE `badizo_recovery_12345678`;\n');
  assert.equal(await sourceDatabaseFromDump(file),'badizo_recovery_12345678');
  await fs.writeFile(file,'USE `another_shop`;\n');await assert.rejects(sourceDatabaseFromDump(file),/approved/);
  await fs.writeFile(file,'USE `badizo_pos`;\nUSE `badizo_recovery_12345678`;\n');await assert.rejects(sourceDatabaseFromDump(file),/single/);
});
