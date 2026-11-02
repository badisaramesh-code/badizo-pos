const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto');
const {safeFile,verifyRelease,stageRelease,applyWindowsRelease,recoverWindowsRelease}=require('../services/windowsReleaseUpgrade');
const {atomic,json}=require('../services/recoveryControlFiles');
async function fixture(t){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'pos-upgrade-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  async function make(commit){const dir=path.join(root,'source-'+commit);await fs.mkdir(dir);
    const files=[];for(const name of ['backend/server.js','backend/package-lock.json','backend/node_modules/mysql2/package.json','frontend/build/index.html','database/migrations/sync-release.json']){
      const target=path.join(dir,name),data=Buffer.from('fixture '+commit);await fs.mkdir(path.dirname(target),{recursive:true});await fs.writeFile(target,data);files.push({path:name,sha256:crypto.createHash('sha256').update(data).digest('hex')});
    }
    await atomic(path.join(dir,'windows-release.json'),{schemaVersion:1,platform:'win32',arch:'x64',commit,nodeMajor:24,mysqlSeries:'8.0',files});return (await stageRelease(dir,path.join(root,'installation'))).directory;
  }
  const previous=await make('a'.repeat(40)),release=await make('b'.repeat(40)),installation=path.join(root,'installation'),bindingPath=path.join(root,'binding.json');
  const binding={shopId:'HFM001',activationId:crypto.randomUUID(),generation:1,phase:'active',billingMode:'active',database:{database:'shop'}};
  await atomic(bindingPath,binding);await atomic(path.join(installation,'current-release.json'),{commit:'a'.repeat(40),directory:previous});
  const backup=path.join(root,'backup.sql'),bytes=Buffer.from('verified synthetic backup');await fs.writeFile(backup,bytes);
  const calls=[];const adapters={drain:async()=>calls.push('drain'),backup:async()=>{calls.push('backup');return {path:backup,sha256:crypto.createHash('sha256').update(bytes).digest('hex')};},stop:async()=>calls.push('stop'),start:async()=>calls.push('start'),installSchema:async()=>calls.push('schema'),ready:async commit=>{assert.equal((await json(bindingPath)).phase,'validating');calls.push('ready-'+commit[0]);}};
  return {root:installation,bindingPath,shopId:'HFM001',release,previous,binding,adapters,calls};
}
test('Windows package paths reject secrets, traversal and database backups',()=>{
  for(const name of ['../server.js','C:/secret','backend/.env','backup.sql','backend/private.pem','a\\b'])assert.equal(safeFile(name),false);
  assert.equal(safeFile('database/migrations/optional-sync-inbox.sql'),true);
});
test('staging verifies bytes and rejects injected unlisted executable files',async t=>{
  const f=await fixture(t);await verifyRelease(f.release);await fs.writeFile(path.join(f.release,'backend/injected.js'),'bad');await assert.rejects(verifyRelease(f.release),/Unlisted/);
});
test('upgrade retains previous release and configuration, backups precede installation, writes open only after readiness',async t=>{
  const f=await fixture(t);assert.equal((await applyWindowsRelease(f)).state,'complete');
  assert.equal((await json(path.join(f.root,'current-release.json'))).commit,'b'.repeat(40));assert.equal((await json(f.bindingPath)).phase,'active');await verifyRelease(f.previous);
  assert.ok(f.calls.indexOf('backup')<f.calls.indexOf('schema'));assert.ok(f.calls.includes('ready-b'));
});
test('failed new startup returns to the old binary without restoring or deleting a database',async t=>{
  const f=await fixture(t),ready=f.adapters.ready;f.adapters.ready=async commit=>{if(commit[0]==='b')throw Error('new startup failed');await ready(commit);};
  await assert.rejects(applyWindowsRelease(f),/new startup failed/);assert.equal((await json(path.join(f.root,'current-release.json'))).commit,'a'.repeat(40));assert.deepEqual(await json(f.bindingPath),f.binding);assert.equal((await json(path.join(f.root,'upgrade.json'))).state,'rolled-back');
});
test('recovery after committed activation never rolls back a possibly used new release',async t=>{
  const f=await fixture(t);await applyWindowsRelease(f);const file=path.join(f.root,'upgrade.json'),journal=await json(file);await atomic(file,{...journal,state:'committing'});f.adapters.stop=async()=>assert.fail('Must not stop the committed new release');assert.equal((await recoverWindowsRelease(f)).state,'complete');
});
