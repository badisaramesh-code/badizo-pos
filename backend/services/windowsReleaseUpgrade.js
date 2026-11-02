const fs=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto');
const {atomic,json}=require('./recoveryControlFiles');
const hash=data=>crypto.createHash('sha256').update(data).digest('hex');
function assertBindingSnapshot(binding,expected){
  if(!expected)return;
  const fields=['shopId','activationId','generation','phase','billingMode','handoffId'];
  const databaseFields=['host','port','user','password','database'];
  if(fields.some(key=>binding[key]!==expected[key])||databaseFields.some(key=>binding.database?.[key]!==expected.database?.[key]))throw Error('Runtime binding changed after database verification. Retry upgrade planning.');
}
function safeFile(name){
  return typeof name==='string'&&name.length<240&&!name.includes('\\')&&!name.includes(':')&&!name.startsWith('/')&&name.split('/').every(part=>part&&part!=='.'&&part!=='..')
    &&(!/\.sql$/i.test(name)||/^database\/migrations\/optional-sync-[a-z-]+\.sql$/.test(name))
    &&!/\.(pem|key|pfx|p12|gz|sqlite|db|log)$/i.test(name)&&!/(^|\/)(\.env[^/]*|backups?|logs|secrets?|credentials?)(\/|$)/i.test(name);
}
async function verifyRelease(directory){
  if((await fs.lstat(directory)).isSymbolicLink()||(await fs.lstat(path.join(directory,'windows-release.json'))).isSymbolicLink())throw Error('Release links are not allowed.');
  const manifest=await json(path.join(directory,'windows-release.json'));
  if(manifest.schemaVersion!==1||manifest.platform!=='win32'||manifest.arch!=='x64'||!/^[a-f0-9]{40}$/.test(manifest.commit)||manifest.nodeMajor!==24||manifest.mysqlSeries!=='8.0'||!Array.isArray(manifest.files)||!manifest.files.length)throw Error('Unsupported Windows release.');
  const seen=new Set();
  for(const file of manifest.files){
    if(!safeFile(file.path)||seen.has(file.path.toLowerCase())||!/^[a-f0-9]{64}$/.test(file.sha256))throw Error('Unsafe or repeated release path.');
    seen.add(file.path.toLowerCase());
    let cursor=directory;
    for(const part of file.path.split('/')){cursor=path.join(cursor,part);const stat=await fs.lstat(cursor);if(stat.isSymbolicLink())throw Error('Release links are not allowed.');}
    const stat=await fs.stat(cursor);if(!stat.isFile()||hash(await fs.readFile(cursor))!==file.sha256)throw Error('Release checksum mismatch: '+file.path);
  }
  for(const required of ['backend/server.js','backend/package-lock.json','backend/node_modules/mysql2/package.json','frontend/build/index.html','database/migrations/sync-release.json'])if(!seen.has(required))throw Error('Incomplete Windows release.');
  async function inspect(folder,prefix=''){
    for(const entry of await fs.readdir(folder,{withFileTypes:true})){
      const name=prefix+entry.name;
      if(entry.isSymbolicLink())throw Error('Release links are not allowed.');
      if(entry.isDirectory())await inspect(path.join(folder,entry.name),name+'/');
      else if(!entry.isFile()||(!seen.has(name.toLowerCase())&&name!=='windows-release.json'&&!/^backend\/logs\/[^/]+\.log(?:\.[0-9]+)?$/.test(name)))throw Error('Unlisted release file: '+name);
    }
  }
  await inspect(directory);
  return manifest;
}
async function stageRelease(source,root){
  if(!path.isAbsolute(source)||!path.isAbsolute(root))throw Error('Absolute staging paths required.');
  const manifest=await verifyRelease(source),destination=path.join(root,'releases',manifest.commit);
  await fs.mkdir(path.dirname(destination),{recursive:true});
  try{const previous=await verifyRelease(destination);if(hash(JSON.stringify(previous))!==hash(JSON.stringify(manifest)))throw Error('Commit already staged with different contents.');return {directory:destination,manifest};}catch(error){if(error.code!=='ENOENT')throw error;}
  const staging=destination+'.staging-'+crypto.randomUUID();await fs.mkdir(staging);
  for(const file of manifest.files){
    const target=path.join(staging,...file.path.split('/'));await fs.mkdir(path.dirname(target),{recursive:true});
    await fs.copyFile(path.join(source,...file.path.split('/')),target,require('node:fs').constants.COPYFILE_EXCL);
  }
  await atomic(path.join(staging,'windows-release.json'),manifest);await verifyRelease(staging);await fs.rename(staging,destination);
  return {directory:destination,manifest};
}
// Adapters are supplied by a protected on-host installer configuration, never
// by a web request or by release contents. No database is restored on rollback.
async function applyWindowsRelease({root,bindingPath,shopId,release,adapters,expectedBinding}){
  if(!path.isAbsolute(root)||!path.isAbsolute(bindingPath))throw Error('Absolute protected upgrade paths required.');
  const manifest=await verifyRelease(release),pointerPath=path.join(root,'current-release.json'),journalPath=path.join(root,'upgrade.json');
  if(release!==path.join(root,'releases',manifest.commit))throw Error('Only a staged release can be installed.');
  await fs.mkdir(root,{recursive:true});const lockPath=path.join(root,'upgrade.lock');
  const lock=await fs.open(lockPath,'wx',0o600);await lock.writeFile(String(process.pid));await lock.sync();
  let journal,committed=false;
  try{
    const binding=await json(bindingPath);
    assertBindingSnapshot(binding,expectedBinding);
    if(binding.shopId!==shopId||binding.phase!=='active'||binding.handoffId)throw Error('Shop binding is not ready for upgrade.');
    let previousJournal;try{previousJournal=await json(journalPath);}catch(error){if(error.code!=='ENOENT')throw error;}
    if(previousJournal&&!['complete','rolled-back'].includes(previousJournal.state))throw Error('Interrupted upgrade requires recovery inspection; do not overwrite its journal.');
    const previous=await json(pointerPath);
    if(previous.directory!==path.join(root,'releases',previous.commit)||!/^[a-f0-9]{40}$/.test(previous.commit))throw Error('Invalid installed release pointer.');
    if(previous.commit===manifest.commit)return {state:'already-installed',commit:manifest.commit};
    await verifyRelease(previous.directory);
    journal={schemaVersion:1,shopId,state:'preparing',previous,target:{directory:release,commit:manifest.commit},binding,startedAt:new Date().toISOString()};
    await atomic(journalPath,journal);
    await atomic(bindingPath,{...binding,phase:'validating'});
    await adapters.drain(binding.activationId);
    journal.state='backing-up';await atomic(journalPath,journal);
    journal.backup=await adapters.backup();
    if(!journal.backup||!path.isAbsolute(journal.backup.path)||!/^[a-f0-9]{64}$/.test(journal.backup.sha256))throw Error('Verified backup evidence required.');
    const backupBytes=await fs.readFile(journal.backup.path);if(!backupBytes.length||hash(backupBytes)!==journal.backup.sha256)throw Error('Backup evidence does not match.');
    journal.state='stopping';await atomic(journalPath,journal);await adapters.stop();
    await adapters.installSchema(release,binding.database.database);
    journal.state='starting';await atomic(journalPath,journal);
    await atomic(pointerPath,journal.target);await adapters.start();
    await adapters.ready(manifest.commit,binding.activationId);
    journal.state='committing';await atomic(journalPath,journal);
    await atomic(bindingPath,{...binding,generation:binding.generation+1,phase:'active'});committed=true;
    journal.state='complete';await atomic(journalPath,journal);return {state:'complete',commit:manifest.commit};
  }catch(error){
    if(committed)throw Error('New release may contain sales. Preserve the upgrade journal; automatic rollback is prohibited.');
    if(journal){
      try{
        await adapters.stop();await atomic(pointerPath,journal.previous);
        await atomic(bindingPath,{...journal.binding,phase:'validating'});await adapters.start();
        await adapters.ready(journal.previous.commit,journal.binding.activationId);
        await atomic(bindingPath,journal.binding);journal.state='rolled-back';await atomic(journalPath,journal);
      }catch{journal.state='recovery-required';await atomic(journalPath,journal);throw Error('Upgrade recovery requires inspection. Both releases and the database were retained.');}
    }
    throw error;
  }finally{await lock.close();await fs.unlink(lockPath);}
}
async function recoverWindowsRelease({root,bindingPath,shopId,adapters,expectedBinding}){
  const lockPath=path.join(root,'upgrade.lock');
  try{
    const pid=Number(await fs.readFile(lockPath,'utf8'));if(!Number.isSafeInteger(pid)||pid<=0)throw Error('Invalid upgrade lock; inspect it manually.');
    try{process.kill(pid,0);throw Error('Upgrade process still exists; recovery refused.');}catch(error){if(error.code!=='ESRCH')throw error;}
    await fs.unlink(lockPath);
  }catch(error){if(error.code!=='ENOENT')throw error;}
  const lock=await fs.open(lockPath,'wx',0o600);await lock.writeFile(String(process.pid));await lock.sync();
  try{
    const journalPath=path.join(root,'upgrade.json'),journal=await json(journalPath),binding=await json(bindingPath),pointerPath=path.join(root,'current-release.json'),pointer=await json(pointerPath);
    assertBindingSnapshot(binding,expectedBinding);
    if(journal.shopId!==shopId||binding.shopId!==shopId||journal.binding.activationId!==binding.activationId)throw Error('Upgrade recovery identity differs.');
    for(const item of [journal.previous,journal.target])if(item.directory!==path.join(root,'releases',item.commit)||!/^[a-f0-9]{40}$/.test(item.commit))throw Error('Invalid recovery release pointer.');
    if(['complete','rolled-back'].includes(journal.state))return {state:journal.state};
    if(journal.state==='committing'&&binding.phase==='active'&&pointer.commit===journal.target.commit){journal.state='complete';await atomic(journalPath,journal);return {state:'complete'};}
    if(binding.phase!=='validating')throw Error('Billing may have resumed; automatic rollback is prohibited.');
    await verifyRelease(journal.previous.directory);await adapters.stop();await atomic(pointerPath,journal.previous);await adapters.start();
    await adapters.ready(journal.previous.commit,binding.activationId);await atomic(bindingPath,journal.binding);
    journal.state='rolled-back';await atomic(journalPath,journal);return {state:'rolled-back'};
  }finally{await lock.close();await fs.unlink(lockPath);}
}
module.exports={safeFile,verifyRelease,stageRelease,applyWindowsRelease,recoverWindowsRelease};
