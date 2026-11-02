const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
const {execFile}=require('node:child_process'),{promisify}=require('node:util');
const run=promisify(execFile),launcher=path.resolve(__dirname,'../../tools/fleet/run-windows-release.cjs');

test('actual release launcher keeps external shop settings and original backup location across release directories',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'pos launcher '));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const commit='c'.repeat(40),directory=path.join(root,'releases',commit),backend=path.join(directory,'backend');
  await fs.mkdir(backend,{recursive:true});
  await fs.writeFile(path.join(backend,'server.js'),`console.log(JSON.stringify(Object.fromEntries(['BADIZO_RELEASE_COMMIT','BADIZO_RUNTIME_BINDING','BADIZO_SHOP_ID','BACKUP_DIR','BADIZO_DB_BOOTSTRAP','TEST_PRINTER_SETTING','TEST_DRIVE_SETTING','BADIZO_SYNC_ENROLLMENT_CONFIG'].map(key=>[key,process.env[key]??null]))));`);
  const environmentFile=path.join(root,'shop settings.env'),bindingPath=path.join(root,'runtime binding.json'),manualBackupDirectory=path.join(root,'existing shop backups');
  await fs.writeFile(environmentFile,'TEST_PRINTER_SETTING=existing-counter-printer\nTEST_DRIVE_SETTING=existing-backup-config\n');
  await fs.writeFile(bindingPath,'{}');
  await fs.writeFile(path.join(root,'current-release.json'),JSON.stringify({commit,directory}));
  const configFile=path.join(root,'launcher.json');
  await fs.writeFile(configFile,JSON.stringify({root,shopId:'HFM001',environmentFile,bindingPath,manualBackupDirectory}));
  const env={...process.env};
  for(const key of Object.keys(env))if(key.startsWith('BADIZO_')||['BACKUP_DIR','TEST_PRINTER_SETTING','TEST_DRIVE_SETTING','NODE_OPTIONS'].includes(key))delete env[key];
  const {stdout}=await run(process.execPath,[launcher,configFile],{env,windowsHide:true,timeout:10000});
  const observed=JSON.parse(stdout.trim());
  assert.deepEqual(observed,{BADIZO_RELEASE_COMMIT:commit,BADIZO_RUNTIME_BINDING:bindingPath,BADIZO_SHOP_ID:'HFM001',BACKUP_DIR:manualBackupDirectory,BADIZO_DB_BOOTSTRAP:'false',TEST_PRINTER_SETTING:'existing-counter-printer',TEST_DRIVE_SETTING:'existing-backup-config',BADIZO_SYNC_ENROLLMENT_CONFIG:null});
  assert.equal(await fs.readFile(environmentFile,'utf8'),'TEST_PRINTER_SETTING=existing-counter-printer\nTEST_DRIVE_SETTING=existing-backup-config\n');
});
