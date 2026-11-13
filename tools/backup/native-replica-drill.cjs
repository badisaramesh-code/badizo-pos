'use strict';
// Explicit isolated integration drill. Never takes a production configuration.
const fs=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto'),os=require('node:os'),{spawn}=require('node:child_process'),{once}=require('node:events');
const mysql=require('../../backend/node_modules/mysql2/promise');
const {createNativeReplicaControl,compareCoordinates}=require('../../backend/services/nativeReplicaControl');
const {createNativeReplicaAgent,writeReplicaStatus}=require('../../backend/services/nativeReplicaAgent');
const {optionalJson}=require('../../backend/services/nativeReplicaSettings');
const assert=require('node:assert/strict');
async function main(){
 if(process.platform!=='win32'||process.argv[2]!=='--isolated')throw Error('Use --isolated on Windows; no production input is supported.');
 const base='C:/Program Files/MySQL/MySQL Server 8.0',exe=path.join(base,'bin/mysqld.exe');
 const root=path.resolve(__dirname,'../../../native-replica-drill-'+crypto.randomUUID());
 // The path is a NEW sibling of the source worktree under workspace outputs.
 const workspace=path.resolve(__dirname,'../../../..');if(!root.startsWith(workspace+path.sep))throw Error('Fixture path escaped workspace.');
 await fs.mkdir(root,{recursive:false});
 const password=crypto.randomBytes(24).toString('hex'),replPass=crypto.randomBytes(16).toString('hex');
 const nodes=[{name:'source',port:34081,id:34081},{name:'replica',port:34082,id:34082}];
 let cloudPool,source,locker;const results=[];let cloud;
 const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
 async function finish(child){if(child.exitCode!==null)return child.exitCode;const [code]=await once(child,'exit');return code;}
 function launch(args){const child=spawn(exe,args,{windowsHide:true,stdio:'ignore'});child.on('error',()=>{});try{os.setPriority(child.pid,os.constants.priority.PRIORITY_BELOW_NORMAL);}catch{}return child;}
 async function connect(node,pass=password){return mysql.createConnection({host:'127.0.0.1',port:node.port,user:'root',password:pass,connectTimeout:1000,multipleStatements:false});}
 async function ready(node,pass=password){const end=Date.now()+45000;while(Date.now()<end){if(node.child?.exitCode!==null)throw Error(node.name+' fixture stopped before readiness.');try{return await connect(node,pass);}catch{await wait(150);}}throw Error(node.name+' fixture did not become ready.');}
 function args(node){return ['--no-defaults','--basedir='+base,'--datadir='+node.dir,'--port='+node.port,'--bind-address=127.0.0.1','--mysqlx=OFF','--server-id='+node.id,'--log-bin='+path.join(node.dir,'binlog'),'--binlog-format=ROW','--binlog-row-image=FULL','--binlog-expire-logs-seconds=2592000','--skip-replica-start','--replica-parallel-workers=0','--innodb-buffer-pool-size=32M','--innodb-redo-log-capacity=64M','--innodb-log-buffer-size=8M','--max-connections=12','--performance-schema=ON','--performance-schema-instrument=%=OFF','--log-error='+path.join(node.dir,'error.log'),...(node.readOnly?['--read-only=ON','--super-read-only=ON','--replicate-wild-do-table=hfm001:badizo\\_pos.%','--replicate-do-db=hfm001:badizo_pos']:[])];}
 async function stop(node){
  if(!node.child||node.child.exitCode!==null)return;
  let c;try{c=await connect(node);const [rows]=await c.query('SELECT @@server_uuid AS uuid');if(node.uuid&&rows[0].uuid!==node.uuid)throw Error('Refusing to stop an unowned MySQL identity.');await c.query('SHUTDOWN');}catch(error){if(!['PROTOCOL_CONNECTION_LOST','ECONNRESET'].includes(error.code||'')&&node.child.exitCode===null)node.child.kill();}finally{if(c)await c.end().catch(()=>{});}
  await Promise.race([finish(node.child),wait(10000)]);if(node.child.exitCode===null){node.child.kill();await finish(node.child);}
 }
 try{
  await Promise.all(nodes.map(async node=>{node.dir=path.join(root,node.name);await fs.mkdir(node.dir);const child=launch(['--no-defaults','--initialize-insecure','--basedir='+base,'--datadir='+node.dir]);if(await finish(child)!==0)throw Error('Isolated initialization failed: '+node.name);}));
  for(const node of nodes){node.child=launch(args(node));const c=await ready(node,'');await c.query("ALTER USER 'root'@'localhost' IDENTIFIED BY ?",[password]);const [rows]=await c.query('SELECT @@server_uuid AS uuid');node.uuid=rows[0].uuid;await c.end();}
  source=await connect(nodes[0]);cloud=await connect(nodes[1]);
  await source.query("CREATE USER 'delta_repl'@'127.0.0.1' IDENTIFIED BY ?",[replPass]);await source.query("GRANT REPLICATION SLAVE ON *.* TO 'delta_repl'@'127.0.0.1'");
  const ddl=['CREATE DATABASE badizo_pos','CREATE TABLE badizo_pos.invoices(id INT PRIMARY KEY,amount DECIMAL(12,2)) ENGINE=InnoDB','CREATE TABLE badizo_pos.ledger(id INT PRIMARY KEY,amount DECIMAL(12,2)) ENGINE=InnoDB','CREATE TABLE badizo_pos.products(id INT PRIMARY KEY,stock INT) ENGINE=InnoDB','INSERT INTO badizo_pos.invoices VALUES(1,10)','INSERT INTO badizo_pos.ledger VALUES(1,10)','INSERT INTO badizo_pos.products VALUES(1,100)'];
  for(const sql of ddl){await source.query(sql);await cloud.query(sql);}
  const [baselineRows]=await source.query('SHOW MASTER STATUS');const baseline={file:baselineRows[0].File,position:baselineRows[0].Position};
  await cloud.query("CREATE USER 'delta_apply'@'localhost' ACCOUNT LOCK");await cloud.query("GRANT REPLICATION_APPLIER ON *.* TO 'delta_apply'@'localhost'");await cloud.query("GRANT ALL PRIVILEGES ON `badizo\\_pos`.* TO 'delta_apply'@'localhost'");await cloud.query("CREATE USER 'unsafe_apply'@'localhost' ACCOUNT LOCK");await cloud.query("GRANT REPLICATION_APPLIER ON *.* TO 'unsafe_apply'@'localhost'");await cloud.query("GRANT ALL PRIVILEGES ON badizo_pos.* TO 'unsafe_apply'@'localhost'");
  await cloud.query("CHANGE REPLICATION SOURCE TO SOURCE_HOST='127.0.0.1', SOURCE_PORT=34081, SOURCE_USER='delta_repl', SOURCE_PASSWORD=?, SOURCE_AUTO_POSITION=0, SOURCE_LOG_FILE=?, SOURCE_LOG_POS=?, GET_SOURCE_PUBLIC_KEY=1, PRIVILEGE_CHECKS_USER='delta_apply'@'localhost', REQUIRE_ROW_FORMAT=1, REQUIRE_TABLE_PRIMARY_KEY_CHECK=OFF FOR CHANNEL 'hfm001'",[replPass,baseline.file,baseline.position]);
  await cloud.query("CHANGE REPLICATION FILTER REPLICATE_DO_DB = (badizo_pos), REPLICATE_WILD_DO_TABLE = (?) FOR CHANNEL 'hfm001'",['badizo\\_pos.%']);
  await cloud.query("START REPLICA IO_THREAD FOR CHANNEL 'hfm001'");
  const end=Date.now()+15000;let status;do{const [rows]=await cloud.query("SHOW REPLICA STATUS FOR CHANNEL 'hfm001'");status=rows[0];if(status.Source_UUID===nodes[0].uuid)break;await wait(100);}while(Date.now()<end);assert.equal(status.Source_UUID,nodes[0].uuid);
  await cloud.query("STOP REPLICA FOR CHANNEL 'hfm001'");await cloud.query('SET GLOBAL read_only=ON');await cloud.query('SET GLOBAL super_read_only=ON');
  cloudPool=mysql.createPool({host:'127.0.0.1',port:34082,user:'root',password,connectionLimit:1,connectTimeout:1000});
  const config={shopId:'HFM001',channel:'hfm001',database:'badizo_pos',sourceUuid:nodes[0].uuid,replicaUuid:nodes[1].uuid,baselineSha256:'a'.repeat(64),baselineRestoreVerified:true,applierUser:'delta_apply',applierHost:'localhost'};
  let authority=true;const withSession=async fn=>{const c=await cloudPool.getConnection();try{return await fn((sql,args)=>c.query({sql,timeout:5000},args));}finally{c.release();}};
  await cloud.query("CHANGE REPLICATION SOURCE TO PRIVILEGE_CHECKS_USER='unsafe_apply'@'localhost' FOR CHANNEL 'hfm001'");
  const unsafe=createNativeReplicaControl({withSession,config:{...config,applierUser:'unsafe_apply'},verifyAuthority:async()=>authority});await assert.rejects(unsafe.inspect(),/database-name wildcard/);
  const [unsafeGrants]=await cloud.query("SHOW GRANTS FOR 'unsafe_apply'@'localhost'");
  await cloud.query("CHANGE REPLICATION SOURCE TO PRIVILEGE_CHECKS_USER='delta_apply'@'localhost' FOR CHANNEL 'hfm001'");
  const [safeGrants]=await cloud.query("SHOW GRANTS FOR 'delta_apply'@'localhost'");await fs.writeFile(path.join(root,'grant-proof.json'),JSON.stringify({safeGrants,unsafeGrants},null,2));
  const control=createNativeReplicaControl({withSession,config,verifyAuthority:async()=>authority});await control.inspect();results.push('Actual SHOW GRANTS escaped database scope accepted; raw underscore-wildcard grant rejected.');
  async function sale(id,amount){await source.beginTransaction();try{await source.query('INSERT INTO badizo_pos.invoices VALUES(?,?)',[id,amount]);await source.query('INSERT INTO badizo_pos.ledger VALUES(?,?)',[id,amount]);await source.query('UPDATE badizo_pos.products SET stock=stock-1 WHERE id=1');await source.commit();}catch(error){await source.rollback();throw error;}}
  async function point(){const [rows]=await source.query('SHOW MASTER STATUS');return {file:rows[0].File,position:rows[0].Position};}
  await sale(2,20);const target=await point();await sale(3,30);
  await control.startUntil(target);for(let i=0;i<100;i++){const r=await control.inspect();if(compareCoordinates(r.applied,target)===0)break;await wait(100);}const applied=await control.pause();assert.equal(compareCoordinates(applied.applied,target),0);
  const [first]=await cloud.query('SELECT id FROM badizo_pos.invoices ORDER BY id');assert.deepEqual(first.map(r=>r.id),[1,2]);const [ledger]=await cloud.query('SELECT id FROM badizo_pos.ledger ORDER BY id');assert.deepEqual(ledger.map(r=>r.id),[1,2]);results.push('Exact UNTIL endpoint excluded later committed sale and kept multi-table transaction intact.');
  locker=await connect(nodes[1]);await locker.query('LOCK TABLES badizo_pos.invoices READ');
  const directory=path.join(root,'control');await fs.mkdir(directory);const stateFile=path.join(directory,'native-run.json');let schedule={config:{enabled:true,frequency:'daily',dailyTime:'08:30',timezone:'Asia/Kolkata'},transfersPaused:false},captures=0,lastStatus;
  const options={control,baselineId:'b'.repeat(64),loadSchedule:async()=>schedule,verifyAuthority:async()=>authority,readState:()=>optionalJson(stateFile),saveState:value=>writeReplicaStatus(stateFile,value),
    getSourceCheckpoint:async()=>{captures++;const target=await point();await sale(4,40);return target;},audit:async()=>{},writeStatus:async value=>{lastStatus=value;},clock:()=>Date.parse('2026-11-13T03:30:00Z')};
  let agent=createNativeReplicaAgent(options);await agent.tick();assert.ok(['running','retrying'].includes(lastStatus.state),JSON.stringify(lastStatus));assert.equal(lastStatus.lastSuccessAt,null);schedule.transfersPaused=true;
  const before=Date.now();const sourceWrite=sale(5,50);const unlock=wait(300).then(()=>locker.query('UNLOCK TABLES'));await agent.tick();await Promise.all([unlock,sourceWrite]);
  assert.equal(lastStatus.state,'paused');assert.equal(lastStatus.lastSuccessAt,null);const saved=await optionalJson(stateFile);assert.ok(saved.activeJob);assert.equal(captures,1);results.push('Pause retained unfinished durable target without reporting completion; source accepted writes while cloud was blocked ('+(Date.now()-before)+' ms test interval).');
  await locker.end();locker=null;await cloudPool.end();cloudPool=null;await cloud.end();cloud=null;await stop(nodes[1]);nodes[1].readOnly=true;nodes[1].child=launch(args(nodes[1]));cloud=await ready(nodes[1]);
  const [stoppedRows]=await cloud.query("SHOW REPLICA STATUS FOR CHANNEL 'hfm001'");assert.equal(stoppedRows[0].Replica_IO_Running,'No');assert.equal(stoppedRows[0].Replica_SQL_Running,'No');
  cloudPool=mysql.createPool({host:'127.0.0.1',port:34082,user:'root',password,connectionLimit:1,connectTimeout:1000});schedule.transfersPaused=false;agent=createNativeReplicaAgent({...options,getSourceCheckpoint:async()=>{throw Error('Must not capture a new target after restart');}});await agent.tick();
  for(let i=0;i<100&&lastStatus.state!=='idle';i++){await wait(100);await agent.tick();}assert.equal(lastStatus.state,'idle',JSON.stringify(lastStatus));assert.ok(lastStatus.lastSuccessAt);const final=await optionalJson(stateFile);assert.equal(final.activeJob,null);assert.deepEqual(final.lastCompletedJob.target,saved.activeJob.target);
  const [second]=await cloud.query('SELECT id FROM badizo_pos.invoices ORDER BY id');assert.deepEqual(second.map(r=>r.id),[1,2,3]);results.push('Replica restart honored skip-replica-start; agent restart resumed the persisted exact target and excluded later sales 4/5.');
  authority=false;await agent.tick();assert.equal(lastStatus.state,'blocked');const frozen=await control.inspect();assert.equal(frozen.receiver,'No');assert.equal(frozen.applier,'No');results.push('Authority invalidation stopped/blocked further replication.');
  await fs.writeFile(path.join(root,'report.json'),JSON.stringify({mode:'ISOLATED_ONLY',sourcePort:34081,replicaPort:34082,results,passed:true},null,2));
  console.log(JSON.stringify({fixture:root,passed:true,results}));
 }finally{
  if(locker)await locker.end().catch(()=>{});if(cloudPool)await cloudPool.end().catch(()=>{});if(source)await source.end().catch(()=>{});if(cloud)await cloud.end().catch(()=>{});
  for(const node of nodes)await stop(node);
 }
}
main().catch(error=>{console.error('Isolated native drill failed: '+(error.code==='ERR_ASSERTION'?error.stack:(error.code||error.message)));process.exitCode=1;});
