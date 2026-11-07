const test=require('node:test'),assert=require('node:assert/strict');
const {validateUpgradeDatabase,verifyUpgradeDatabaseIdentity,upgradeDumpArguments}=require('../services/windowsUpgradeDatabase');
const runtime={host:'127.0.0.1',database:'hfm_shop',user:'pos'};
const connection=(serverUuid,databaseName='hfm_shop')=>({query:async()=>[[{serverUuid,databaseName}]]});
test('upgrade requires the supported loopback database while allowing separate installer privileges',()=>{
  assert.equal(validateUpgradeDatabase({...runtime,user:'installer'},{database:runtime}),runtime);
  for(const changed of [{host:'remote.example'},{database:'another_shop'},{port:3307}]) {
    assert.throws(()=>validateUpgradeDatabase({...runtime,...changed},{database:runtime}),/differs/);
  }
});
test('upgrade checks actual server and database identity instead of trusting matching database names',async()=>{
  await verifyUpgradeDatabaseIdentity(connection('same'),connection('same'));
  await assert.rejects(verifyUpgradeDatabaseIdentity(connection('server-a'),connection('server-b')),/same MySQL database/);
  await assert.rejects(verifyUpgradeDatabaseIdentity(connection('same'),connection('same','other')),/same MySQL database/);
});
test('backup overrides host, protocol and port after reading its private defaults file',()=>{
  const args=upgradeDumpArguments('C:\\protected\\backup.cnf',runtime);
  assert.equal(args[0],'--defaults-extra-file=C:\\protected\\backup.cnf');
  assert.ok(args.includes('--host=127.0.0.1'));
  assert.ok(args.includes('--port=3306'));
  assert.ok(args.includes('--protocol=TCP'));
  assert.equal(args.at(-1),'hfm_shop');
  assert.ok(!args.some(value=>value.startsWith('--password')));
});
