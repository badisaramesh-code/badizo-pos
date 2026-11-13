'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
const {createNativeReplicaControl,withNativeRecoveryFence}=require('../services/nativeReplicaControl');
const {createNativeReplicaAgent}=require('../services/nativeReplicaAgent');
const {createNativeReplicaSettings,configuredCloudSyncService}=require('../services/nativeReplicaSettings');
const {verifyNativeAuthority}=require('../services/nativeReplicaAuthority');
const config={shopId:'HFM001',channel:'hfm001',database:'badizo_pos',sourceUuid:'11111111-1111-1111-1111-111111111111',replicaUuid:'22222222-2222-2222-2222-222222222222',baselineSha256:'a'.repeat(64),baselineRestoreVerified:true,applierUser:'delta_apply',applierHost:'localhost'};
function fixture(overrides={},identity={},extra={}){
 const commands=[],queries=[];let held=false;
 const row={Source_UUID:config.sourceUuid,Channel_Name:config.channel,Auto_Position:0,Replicate_Wild_Do_Table:'badizo\\_pos.%',Replicate_Do_DB:'badizo_pos',Replica_IO_Running:'No',Replica_SQL_Running:'No',Source_Log_File:'binlog.000114',Read_Source_Log_Pos:100,Relay_Source_Log_File:'binlog.000114',Exec_Source_Log_Pos:100,Seconds_Behind_Source:0,...overrides};
 const query=async(sql,args)=>{
  queries.push({sql,args});
  if(sql.includes('GET_LOCK')){held=true;return [[{acquired:extra.lockBusy?0:1}]];}
  if(sql.includes('RELEASE_LOCK')){held=false;return [[{released:1}]];}
  if(sql.startsWith('SELECT PRIVILEGE_CHECKS'))return [[{PRIVILEGE_CHECKS_USER:extra.noPrivilegeChecks?null:"'delta_apply'@'localhost'",REQUIRE_ROW_FORMAT:extra.statementEvents?'NO':'YES',REQUIRE_TABLE_PRIMARY_KEY_CHECK:'OFF'}]];
  if(sql.startsWith('SHOW GRANTS'))return [[{grant:'GRANT REPLICATION_APPLIER ON *.* TO account'},{grant:extra.globalGrant?'GRANT ALL PRIVILEGES ON *.* TO account':extra.unescapedGrant?'GRANT ALL PRIVILEGES ON `badizo_pos`.* TO account':'GRANT ALL PRIVILEGES ON `badizo\\_pos`.* TO account'}]];
  if(sql.startsWith('SELECT @@'))return [[{server_uuid:config.replicaUuid,read_only:1,super_read_only:1,...identity}]];
  if(sql.startsWith('SHOW GLOBAL'))return [[{Variable_name:'skip_slave_start',Value:extra.autoStart?'OFF':'ON'},{Variable_name:'replica_parallel_workers',Value:'0'},{Variable_name:'partial_revokes',Value:'OFF'}]];
  if(sql==='SHOW REPLICA STATUS')return [[{...row},...(extra.multiple?[{...row,Channel_Name:'other'}]:[])]];
  assert.equal(held,true,'Control SQL must hold the maintenance lock');commands.push(sql);
  if(sql.startsWith('SET GLOBAL read_only=')){identity.read_only=sql.endsWith('ON')?1:0;return [[]];}
  if(sql.startsWith('SET GLOBAL super_read_only=')){identity.super_read_only=sql.endsWith('ON')?1:0;return [[]];}
  if(sql.startsWith('STOP'))row.Replica_IO_Running=row.Replica_SQL_Running='No';
  else if(sql.startsWith('START REPLICA IO_THREAD'))row.Replica_IO_Running='Yes';
  else if(sql.startsWith('START REPLICA SQL_THREAD')){row.Replica_SQL_Running='Yes';row.Until_Condition='Source';row.Until_Log_File=/SOURCE_LOG_FILE = '([^']+)'/.exec(sql)[1];row.Until_Log_Pos=Number(/SOURCE_LOG_POS = (\d+)/.exec(sql)[1]);}
  else throw Error('Forbidden SQL');return [[]];
 };
 const options={query,config,isCommitted:async()=>false,verifyAuthority:async()=>extra.authority!==false};
 return {control:createNativeReplicaControl(options),commands,queries,row,options,isHeld:()=>held};
}
const target={file:'binlog.000114',position:200};
test('daily start is bounded by UNTIL, serialized with recovery and pause is confirmed',async()=>{
 const f=fixture();await f.control.startUntil(target);
 assert.deepEqual(f.commands,["START REPLICA IO_THREAD FOR CHANNEL 'hfm001'","START REPLICA SQL_THREAD UNTIL SOURCE_LOG_FILE = 'binlog.000114', SOURCE_LOG_POS = 200 FOR CHANNEL 'hfm001'"]);
 await f.control.startUntil(target);assert.equal(f.commands.length,2,'Do not replace the running target');
 await f.control.pause();assert.equal(f.row.Replica_SQL_Running,'No');assert.equal(f.isHeld(),false);
});
test('never controls a source, promoted cloud, broad filter, second channel or auto-starting applier',async()=>{
 for(const f of [fixture({}, {server_uuid:config.sourceUuid}),fixture({}, {super_read_only:0}),fixture({Source_UUID:'wrong'}),fixture({Replicate_Wild_Do_Table:'badizo_pos.%'}),fixture({Replicate_Ignore_Table:'badizo_pos.invoices'}),fixture({}, {},{multiple:true}),fixture({}, {},{autoStart:true}),fixture({}, {},{noPrivilegeChecks:true}),fixture({}, {},{statementEvents:true}),fixture({}, {},{globalGrant:true}),fixture({}, {},{unescapedGrant:true}),fixture({}, {},{authority:false}),fixture({}, {},{lockBusy:true})]){await assert.rejects(f.control.startUntil(target));assert.deepEqual(f.commands,[]);}
});
test('unsafe target names and gap/apply errors never produce START or RESET commands',async()=>{
 const f=fixture();await assert.rejects(f.control.startUntil({file:"binlog.000114'; DROP DATABASE x",position:200}));assert.deepEqual(f.commands,[]);
 for(const error of [{Last_IO_Errno:1236},{Last_SQL_Errno:1062}]){const x=fixture(error);await assert.rejects(x.control.startUntil(target),/requires inspection/);assert.deepEqual(x.commands,[]);}
});
test('restore callback cannot run before the replica is stopped and shares its lock/session',async()=>{
 const f=fixture({Replica_IO_Running:'Yes',Replica_SQL_Running:'Yes'});let called=false;
 await withNativeRecoveryFence(f.options,async({replica,pinned})=>{called=true;assert.equal(replica.applier,'No');assert.equal(pinned.shopId,'HFM001');assert.equal(f.isHeld(),true);});assert.equal(called,true);assert.equal(f.isHeld(),false);
 await assert.rejects(withNativeRecoveryFence(f.options,async()=>{throw Error('restore failed');}),/restore failed/);assert.equal(f.isHeld(),false);
});
function agentFixture(extra={}){
 const f=fixture();let state=null,now=Date.parse('2026-11-13T03:30:00Z'),captures=0,status;
 const schedule={config:{enabled:true,frequency:'daily',dailyTime:'08:30',timezone:'Asia/Kolkata'},transfersPaused:false};const audits=[];
 const agent=createNativeReplicaAgent({control:f.control,baselineId:'b'.repeat(64),loadSchedule:async()=>structuredClone(schedule),verifyAuthority:async()=>true,
  readState:async()=>structuredClone(state),saveState:async value=>{if(extra.failSave)throw Error('disk full');state=structuredClone(value);},getSourceCheckpoint:async()=>{captures++;return target;},
  audit:async(label,job)=>{audits.push({label,job});if(extra.failAudit&&label==='Completed')throw Error('audit unavailable');},writeStatus:async value=>{status=value;},clock:()=>now});
 return {...f,agent,schedule,audits,get state(){return state;},get status(){return status;},get captures(){return captures;},set now(value){now=value;}};
}
test('daily job persists one source target before starting and succeeds only after that applied checkpoint',async()=>{
 const f=agentFixture();await f.agent.tick();assert.deepEqual(f.state.activeJob.target,target);assert.equal(f.status.lastSuccessAt,null);assert.equal(f.status.state,'running');assert.equal(f.captures,1);
 f.row.Exec_Source_Log_Pos=200;f.row.Read_Source_Log_Pos=200;f.row.Replica_SQL_Running='No';await f.agent.tick();assert.equal(f.state.activeJob,null);assert.equal(f.state.lastCompletedDay,'2026-11-13');assert.ok(f.state.lastSuccessAt);assert.equal(f.row.Replica_IO_Running,'No');
 await f.agent.tick();assert.equal(f.captures,1,'No second automatic run on the same day');
});
test('pause retains an unfinished target, never marks success, and resumes the same target',async()=>{
 const f=agentFixture();await f.agent.tick();const id=f.state.activeJob.id;f.schedule.transfersPaused=true;await f.agent.tick();assert.equal(f.status.state,'paused');assert.equal(f.state.lastSuccessAt,null);assert.equal(f.row.Replica_IO_Running,'No');
 f.schedule.transfersPaused=false;await f.agent.tick();assert.equal(f.state.activeJob.id,id);assert.equal(f.captures,1);assert.equal(f.state.activeJob.target.position,200);
});
test('durable checkpoint failures block; optional history failure does not discard confirmed completion',async()=>{
 const noDisk=agentFixture({failSave:true});await noDisk.agent.tick();assert.equal(noDisk.status.state,'blocked');assert.equal(noDisk.commands.some(sql=>sql.startsWith('START')),false);
 const noAudit=agentFixture({failAudit:true});await noAudit.agent.tick();noAudit.row.Exec_Source_Log_Pos=200;noAudit.row.Read_Source_Log_Pos=200;await noAudit.agent.tick();assert.equal(noAudit.status.state,'idle');assert.ok(noAudit.state.lastSuccessAt);assert.equal(noAudit.state.activeJob,null);
});
test('before the daily time the agent remains stopped; missed intervals do not create repeated jobs',async()=>{
 const f=agentFixture();f.now=Date.parse('2026-11-13T02:00:00Z');await f.agent.tick();assert.equal(f.captures,0);assert.equal(f.status.state,'idle');assert.equal(f.status.nextRunAt,'2026-11-13T03:00:00.000Z');
});
async function settingsFixture(fn){const root=await fs.mkdtemp(path.join(os.tmpdir(),'badizo-native-'));try{return await fn(root);}finally{await fs.rm(root,{recursive:true,force:true});}}
test('pause survives connection failure; stale status cannot enable or queue work',async()=>settingsFixture(async directory=>{
 const service=createNativeReplicaSettings({directory});assert.equal((await service.setPaused(true,{role:'ADMIN'})).transfersPaused,true);
 await assert.rejects(service.save({enabled:true,frequency:'daily',dailyTime:'08:30',timezone:'Asia/Kolkata'},{role:'SERVER'}),/not configured/);
 await assert.rejects(service.requestNow({role:'SERVER'}),/Resume/);
}));
test('daily settings and manual queue work; any restore invalidation blocks new work',async()=>settingsFixture(async directory=>{
 await fs.writeFile(path.join(directory,'native-status.json'),JSON.stringify({engine:'mysql-replication',ready:true,state:'idle',heartbeatAt:new Date().toISOString()}));
 const service=createNativeReplicaSettings({directory});const payload={enabled:true,frequency:'daily',dailyTime:'08:30',timezone:'Asia/Kolkata'};
 assert.equal((await service.save(payload,{role:'SERVER'})).config.frequency,'daily');assert.equal((await service.requestNow({role:'SERVER',username:'owner'})).manualPending,true);
 const request=JSON.parse(await fs.readFile(path.join(directory,'native-manual.json')));assert.equal(request.actor,'owner');
 await fs.writeFile(path.join(directory,'native-invalidation.json'),'invalid or partial marker still blocks');await assert.rejects(service.save(payload,{role:'SERVER'}),/not configured/);assert.equal((await service.state()).service.ready,false);
}));
test('authority validates cloud database binding, not just MySQL instance identity',async()=>{
 const authorityConfig={...config,controlDirectory:path.resolve('native-test'),localBindingPath:path.resolve('local-binding.json'),sourceActivationId:'33333333-3333-3333-3333-333333333333',cloudActivationId:'44444444-4444-4444-4444-444444444444',sourceGeneration:1,cloudGeneration:2,sourceDatabasePort:3306,cloudDatabasePort:3306,localReadyUrl:'http://127.0.0.1:5000/api/ready',cloudReadyUrl:'http://127.0.0.1:5500/api/ready'};
 const local={schemaVersion:1,shopId:'HFM001',activationId:authorityConfig.sourceActivationId,generation:1,phase:'active',billingMode:'active',database:{database:'badizo_pos'}};
 const ready=(cloud)=>({ok:true,shopId:'HFM001',nodeRole:cloud?'cloud-standby':'local-server',sync:null,recovery:{activationId:cloud?authorityConfig.cloudActivationId:authorityConfig.sourceActivationId,generation:cloud?2:1,phase:'active',billingMode:cloud?'standby':'active',databaseName:'badizo_pos',databasePort:3306,nativeReplicationInvalidated:false}});
 let cloud=ready(true);const options={config:authorityConfig,readFile:async()=>JSON.stringify(local),lstat:async()=>{throw Object.assign(Error('none'),{code:'ENOENT'});},fetchReady:async url=>({ok:true,text:async()=>JSON.stringify(String(url).includes(':5500')?cloud:ready(false))})};
 assert.equal(await verifyNativeAuthority(options),true);
 for(const change of [{databaseName:'replacement_db'},{databasePort:3307},{activationId:'new'},{generation:3},{nativeReplicationInvalidated:true},{billingMode:'active'}]){cloud=ready(true);Object.assign(cloud.recovery,change);assert.equal(await verifyNativeAuthority(options),false);}
 cloud=ready(true);cloud.sync={state:'active'};assert.equal(await verifyNativeAuthority(options),false);
});

test('applied checkpoint overshoot is blocked rather than reported as daily completion',async()=>{
 const f=agentFixture();await f.agent.tick();f.row.Exec_Source_Log_Pos=201;f.row.Read_Source_Log_Pos=201;await f.agent.tick();assert.equal(f.status.state,'blocked');assert.equal(f.state.lastSuccessAt,null);assert.ok(f.state.activeJob);assert.equal(f.row.Replica_SQL_Running,'No');
});
test('optional native mode misconfiguration disables sync controls without aborting billing startup',async()=>{
 const keys=['BADIZO_NATIVE_REPLICATION_DIR','BADIZO_SYNC_ENROLLMENT_CONFIG'];const saved=Object.fromEntries(keys.map(key=>[key,process.env[key]]));
 try{process.env.BADIZO_NATIVE_REPLICATION_DIR=path.resolve('isolated-native-config');process.env.BADIZO_SYNC_ENROLLMENT_CONFIG=path.resolve('event-enrollment.json');const service=configuredCloudSyncService();const state=await service.state();assert.equal(state.service.ready,false);assert.equal(state.editable,false);await assert.rejects(service.requestNow(),/local billing can continue/);}
 finally{for(const key of keys){if(saved[key]===undefined)delete process.env[key];else process.env[key]=saved[key];}}
});

test('native recovery restores readonly only before a proved uncommitted failure',async()=>{
 const f=fixture();await assert.rejects(withNativeRecoveryFence({...f.options,isCommitted:async()=>false},async({query})=>{await query('SET GLOBAL super_read_only=OFF');await query('SET GLOBAL read_only=OFF');throw Error('import failed');}),/import failed/);
 assert.equal((await f.control.inspect()).ready,true);assert.equal(f.isHeld(),false);
 const g=fixture();await assert.rejects(withNativeRecoveryFence({...g.options,isCommitted:async()=>true},async({query})=>{await query('SET GLOBAL super_read_only=OFF');await query('SET GLOBAL read_only=OFF');throw Error('postcommit journal failure');}),error=>error.commitVerified===true);
 assert.equal(g.commands.some(sql=>sql==='SET GLOBAL read_only=ON'),false);assert.equal(g.isHeld(),false);
});
