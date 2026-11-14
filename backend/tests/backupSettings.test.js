'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const cfg=require('../services/backupConfiguration');
test('persisted switches override legacy environment; local copies default on',()=>{
  assert.equal(cfg.backupConfiguration({GOOGLE_DRIVE_SYNC_FOLDER:'fixture'}).cloudEnabled,true);
  assert.equal(cfg.backupConfiguration({GOOGLE_DRIVE_SYNC_FOLDER:'fixture',GOOGLE_DRIVE_BACKUP_ENABLED:'false'}).cloudEnabled,false);
  const c=cfg.backupConfiguration({GOOGLE_DRIVE_BACKUP_ENABLED:'true'},{backup_drive_enabled:'false',backup_keep_local:'false'});
  assert.equal(c.cloudEnabled,false);assert.equal(c.keepLocal,true);
  assert.equal(cfg.backupConfiguration({GOOGLE_DRIVE_BACKUP_ENABLED:'true'}).keepLocal,true);
});
test('backup settings validation is strict and disabling Drive forces local copies',()=>{
  const result=cfg.validateBackupSettings({backup_local_folder:path.resolve('fixture'),backup_drive_enabled:false,backup_keep_local:false,backup_local_keep_count:14},{});
  assert.equal(result.backup_keep_local,'true');assert.equal(result.backup_drive_enabled,'false');
  for(const invalid of [{backup_local_folder:'relative'},{backup_local_keep_count:-1},{backup_drive_keep_count:0},{backup_daily_time:'29:00'}])assert.throws(()=>cfg.validateBackupSettings(invalid,{}));
});
test('settings reader is bounded, read-only and propagates DB failures',async()=>{
  const c=await cfg.loadBackupConfiguration({async query(sql,args){assert.match(sql,/SELECT.*WHERE setting_key IN/);assert.equal(args[0],cfg.BACKUP_SETTING_KEYS);return [[{setting_key:'backup_drive_enabled',setting_value:'false'}]];}},{GOOGLE_DRIVE_BACKUP_ENABLED:'true'});
  assert.equal(c.cloudEnabled,false);
  await assert.rejects(cfg.loadBackupConfiguration({query:async()=>{throw Error('DB unavailable');}}),/DB unavailable/);
});
function loadService(files,remote,env={}){
  const removed=[];
  const deps={fs:{existsSync:()=>true,promises:{readdir:async()=>files.map(f=>f.name),stat:async file=>{const f=files.find(item=>path.basename(file)===item.name);return {size:f.size,birthtime:new Date(f.time),mtime:new Date(f.time)};},rm:async file=>removed.push(path.basename(file))}},path,os:require('node:os'),child_process:{},zlib:{},stream:{},dotenv:{config(){}},'../config/db':{},'./logger':{logInfo(){},logError(){}},'./backupConfiguration':cfg,'./googleDriveBackupService':{listDriveBackups:async()=>remote}};
  const context={module:{exports:{}},__dirname:path.join(__dirname,'../services'),process:{env},require(name){if(!(name in deps))throw Error('Unexpected import '+name);return deps[name];}};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../services/backupService.js'),'utf8'),context);
  return {...context.module.exports,removed};
}
test('local retention never removes unuploaded backlog or size-mismatched copies',async()=>{
  const files=[{name:'new.sql',size:10,time:3000},{name:'pending.sql',size:10,time:2000},{name:'wrong.sql',size:10,time:1000},{name:'verified.sql',size:10,time:0}];
  const service=loadService(files,[{name:'wrong.sql',size:9},{name:'verified.sql',size:10}]);
  const c=cfg.backupConfiguration({}, {backup_local_folder:path.resolve('fixture'),backup_drive_enabled:true,backup_local_keep_count:1});
  await service.pruneLocalBackups(1,c);assert.deepEqual(service.removed,['verified.sql']);
  const protectedService=loadService(files,[{name:'verified.sql',size:10}],{BADIZO_RUNTIME_BINDING:'bound'});
  await protectedService.pruneLocalBackups(1,c);assert.equal(protectedService.removed.length,0);
});
test('manual creation/list/download resolve the same configured folder without allowing traversal',async()=>{
  const service=loadService([],[]),c=cfg.backupConfiguration({}, {backup_local_folder:path.resolve('fixture')});
  const sources=await service.getBackupSources(c);
  assert.equal(sources.find(s=>s.key==='manual').dir,path.join(c.root,'manual'));
  assert.equal(await service.getBackupPath('manual::test.sql',c),path.join(c.root,'manual','test.sql'));
  assert.equal(await service.getBackupPath('manual::../test.sql',c),null);
});
test('backup option group is persisted in one statement and invalid settings write nothing',async()=>{
  let handler,writes=[];const router=new Proxy({}, {get:(_t,key)=>(...args)=>{if(key==='post'&&args[0]==='/')handler=args.at(-1);}});
  const deps={express:{Router:()=>router},crypto:require('node:crypto'),'../config/db':{async query(sql,args){if(sql.startsWith('SELECT'))return [[]];writes.push({sql,args});return [[]];}},'../middleware/auth':{authenticate(){},authorize(){return ()=>{};},JWT_SECRET:'fixture'},'../services/backupConfiguration':cfg};
  const context={module:{exports:{}},process:{env:{}},console,Buffer,require(name){if(!(name in deps))throw Error(name);return deps[name];}};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../routes/settings.js'),'utf8'),context);
  let status=200;const res={status(n){status=n;return this;},json(){}};
  await handler({body:{backup_local_keep_count:-1}},res);assert.equal(status,400);assert.equal(writes.length,0);
  await handler({body:{backup_local_folder:path.resolve('fixture'),backup_drive_enabled:false,backup_keep_local:false}},res);
  assert.equal(writes.length,1);assert.match(writes[0].sql,/VALUES \? ON DUPLICATE/);
  assert.equal(writes[0].args[0].find(([key])=>key==='backup_keep_local')[1],'true');
});
test('scheduled no-local-copy choice deletes only verified direct uploads, never failures or desktop copies',async()=>{
  const source=fs.readFileSync(path.join(__dirname,'../scripts/badizo_cloud_backup.js'),'utf8');
  const fn=source.slice(source.indexOf('async function syncDailyBackups('),source.indexOf('\nasync function databaseBackup('));
  for(const mode of ['verified','failed','desktop','bound','unverified']){
    const removed=[],statuses=[],file={name:'badizo_daily_test.sql.gz',path:'fixture'};
    const context={backupConfig:{cloudEnabled:true,keepLocal:false},localBackupFiles:()=>[file],matchesBackupAuthority:()=>true,localBackupKeepCount:()=>0,remoteBackupNames:async()=>new Map(),DRIVE_SYNC_FOLDER:mode==='desktop'?'desktop':'',LOCAL_ROOT:'fixture',jobStarted:0,process:{pid:1},path,console:{log(){},warn(){}},
      fs:{statSync:()=>({size:10,mtime:new Date(0)}),writeFileSync(){},renameSync(){},rmSync:file=>removed.push(file)},
      writeBackupStatus:(...args)=>statuses.push(args),pruneDrive:async()=>{},
      upload:async()=>{if(mode==='failed')throw Error('Offline');return mode==='unverified'?{}:{size:10};}};
    vm.createContext(context);vm.runInContext(fn+'\nthis.run=syncDailyBackups;',context);
    const binding={bound:mode==='bound',assertUnchanged(){}};
    if(mode==='failed')await assert.rejects(context.run(3,binding),/Offline/);else await context.run(3,binding);
    assert.equal(removed.length,mode==='verified'?1:0,mode);
    if(mode==='desktop')assert.equal(statuses[0][2].cloudStatus,'pending');
    assert.equal(statuses[0][2].localAt,new Date(0).toISOString());
  }
});
