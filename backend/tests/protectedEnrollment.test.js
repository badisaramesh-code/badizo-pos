const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const {protectedEnrollment} = require('../services/protectedEnrollment');
const {read} = require('../services/recoveryRuntimeBinding');

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'badizo-capture-gap-'));
  t.after(() => fs.rm(directory,{force:true, recursive:true}));
  const bindingFile = path.join(directory,'binding.json');
  const binding = {schemaVersion:1, shopId:'HFM001', activationId:crypto.randomUUID(), generation:2, phase:'active', billingMode:'active',
    database:{host:'127.0.0.1',database:'qa_pos',user:'test',password:''}};
  const write = () => fs.writeFile(bindingFile, JSON.stringify(binding));
  await write();
  const env = {BADIZO_RUNTIME_BINDING:bindingFile, BADIZO_NODE_ROLE:'local-server', BADIZO_SHOP_ID:'HFM001', DB_NAME:'qa_pos', DB_HOST:'127.0.0.1',
    BADIZO_SYNC_CHECKOUT_CAPTURE:'true', BADIZO_CHECKOUT_REQUEST_GUARD:'true'};
  const opts = {env, bindingService:{read,status:()=>({activationId:binding.activationId})},
    pool:{query:async()=>[[{name:'qa_pos'}]]}, create:async()=>{throw Error('missing sync tables');}};
  return {opts, env, binding, write};
}

test('authorized local starts with sync paused and cannot silently reuse the old enrollment on restart', async t=>{
  const {opts,env,binding,write} = await fixture(t);
  const degraded = await protectedEnrollment(opts);
  assert.equal((await degraded.status()).reason,'capture-gap-requires-baseline');
  assert.equal(env.BADIZO_SYNC_CHECKOUT_CAPTURE,'false');
  assert.equal(env.BADIZO_CHECKOUT_REQUEST_GUARD,'false');
  assert.equal((await degraded.settings.state()).service.ready,false);
  await assert.rejects(degraded.settings.requestNow(),/baseline/);
  let calls = 0;
  const verified = {ready:true};
  opts.create = async()=>{calls++;return verified;};
  await protectedEnrollment(opts);
  assert.equal(calls,0);
  binding.activationId=crypto.randomUUID(); binding.generation++; await write();
  assert.equal(await protectedEnrollment(opts),verified);
  assert.equal(calls,1);
});

test('failed enrollment cannot activate cloud, standby, validating, handoff or mismatched database', async t=>{
  const {opts,env,binding,write} = await fixture(t);
  env.BADIZO_NODE_ROLE='cloud-active';
  await assert.rejects(protectedEnrollment(opts),/missing sync tables/);
  env.BADIZO_NODE_ROLE='local-server';
  for (const [field,value] of [['phase','validating'],['billingMode','standby'],['handoffId','held']]) {
    const old=binding[field];binding[field]=value;await write();
    await assert.rejects(protectedEnrollment(opts),/missing sync tables/);
    binding[field]=old;await write();
  }
  opts.pool.query=async()=>[[{name:'wrong'}]];
  await assert.rejects(protectedEnrollment(opts),/missing sync tables/);
});

test('restored candidate cannot regain old incremental enrollment after validation releases billing', async t=>{
  const {opts,binding,write} = await fixture(t);
  binding.phase='validating';await write();
  const staged={requiresEnrollment:true};
  opts.create=async()=>staged;
  assert.equal(await protectedEnrollment(opts),staged);
  binding.phase='active';await write();
  let attempts=0;
  opts.create=async()=>{attempts++;return {ready:true};};
  const runtime=await protectedEnrollment(opts);
  assert.equal((await runtime.status()).ready,false);
  assert.equal(attempts,0);
});

test('unusable gap evidence or a changed boot activation refuses degraded startup',async t=>{
  const {opts,env,binding}=await fixture(t);
  opts.bindingService.status=()=>({activationId:crypto.randomUUID()});
  await assert.rejects(protectedEnrollment(opts),/missing sync tables/);
  opts.bindingService.status=()=>({activationId:binding.activationId});
  await fs.mkdir(env.BADIZO_RUNTIME_BINDING+'.'+binding.activationId+'.capture-gap');
  await assert.rejects(protectedEnrollment(opts),/Invalid capture gap evidence/);
});
