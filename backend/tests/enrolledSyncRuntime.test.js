const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const {validateConfiguration,createEnrolledSyncRuntime}=require('../services/enrolledSyncRuntime');
const {atomic}=require('../services/recoveryControlFiles');
function configuration(directory){return {schemaVersion:1,contractVersion:1,shopId:'HFM001',installationId:'local-test',peerInstallationId:'cloud-test',nodeRole:'local-server',databaseName:'test_database',baselineId:'a'.repeat(64),activationId:crypto.randomUUID(),settingsDirectory:path.join(directory,'settings'),reviewDirectory:path.join(directory,'reviews'),incomingToken:'b'.repeat(64),peer:{baseUrl:'https://example.test/api/sync',token:'c'.repeat(64)}};}
test('enrollment refuses cross-shop identity, insecure transport and credential fields outside the contract',()=>{
  const config=configuration(os.tmpdir()),env={BADIZO_SHOP_ID:'HFM001',BADIZO_NODE_ROLE:'local-server'};
  assert.equal(validateConfiguration(config,env),config);
  assert.throws(()=>validateConfiguration({...config,shopId:'HFM002'},env));
  assert.throws(()=>validateConfiguration({...config,peer:{...config.peer,baseUrl:'http://example.test/api/sync'}},env));
  assert.throws(()=>validateConfiguration({...config,password:'unexpected'},env));
  assert.throws(()=>validateConfiguration({...config,peerInstallationId:config.installationId},env));
});
test('restored activation epoch keeps local service available without reusing stale sync mappings',async t=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'badizo-enrollment-'));t.after(()=>fs.rm(directory,{recursive:true,force:true}));
  const config=configuration(directory),configPath=path.join(directory,'enrollment.json'),bindingPath=path.join(directory,'binding.json');
  await atomic(configPath,config);await atomic(bindingPath,{schemaVersion:1,shopId:'HFM001',activationId:crypto.randomUUID(),generation:2,phase:'active',billingMode:'active',database:{host:'127.0.0.1',user:'test',password:'test',database:'restored_database'}});
  const env={BADIZO_SHOP_ID:'HFM001',BADIZO_NODE_ROLE:'local-server',BADIZO_RUNTIME_BINDING:bindingPath,BADIZO_SYNC_CHECKOUT_CAPTURE:'true'};
  const runtime=await createEnrolledSyncRuntime({pool:{query(){throw Error('Stale enrollment must not touch the database');}},configPath,env});
  assert.equal(env.BADIZO_SYNC_CHECKOUT_CAPTURE,'false');assert.deepEqual(await runtime.status(),{ready:false,reason:'restored-database-requires-enrollment'});
  const state=await runtime.settings.state();assert.equal(state.service.ready,false);assert.match(state.message,/newly verified sync baseline/);
});
