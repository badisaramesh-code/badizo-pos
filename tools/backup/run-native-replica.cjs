'use strict';
// A separate opt-in OS agent. Never executed by a web request or POS startup.
const fs=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto');
const { acquireWorkerLock } = require('./native-worker-lock.cjs');
const mysql=require('../../backend/node_modules/mysql2/promise');
const {createCloudSyncSettingsService}=require('../../backend/services/cloudSyncSettingsService');
const {createNativeReplicaControl,validateReplicaConfig,coordinate}=require('../../backend/services/nativeReplicaControl');
const {createNativeReplicaAgent,writeReplicaStatus}=require('../../backend/services/nativeReplicaAgent');
const {validateAuthorityConfig,verifyNativeAuthority}=require('../../backend/services/nativeReplicaAuthority');
const {optionalJson}=require('../../backend/services/nativeReplicaSettings');
const {appendSyncEvent}=require('../../backend/services/transferAudit');
function connection(value){if(!value||!['127.0.0.1','::1','localhost'].includes(value.host)||!Number.isInteger(value.port)||value.port<1024||value.port>65535||typeof value.user!=='string'||!value.user||typeof value.password!=='string')throw Error('Only fixed protected loopback MySQL credentials are accepted.');return {host:value.host,port:value.port,user:value.user,password:value.password,connectTimeout:3000,multipleStatements:false};}
async function main(){
  if(process.argv.length!==4||process.argv[2]!=='--config'||!path.isAbsolute(process.argv[3]))throw Error('Use --config ABSOLUTE_PRIVATE_CONFIG_PATH.');
  const stat=await fs.lstat(process.argv[3]);if(!stat.isFile()||stat.isSymbolicLink())throw Error('Use a protected regular private configuration file.');
  const config=JSON.parse(await fs.readFile(process.argv[3],'utf8'));validateReplicaConfig(config);validateAuthorityConfig(config);
  if(config.schemaVersion!==1||config.tunnelHostKeyVerified!==true||config.applicationEventSyncDisabled!==true||
    !Number.isSafeInteger(config.minimumLogRetentionDays)||config.minimumLogRetentionDays<30||config.minimumLogRetentionDays>3650||process.env.BADIZO_SYNC_ENROLLMENT_CONFIG)
    throw Error('Verify exclusive native mode, pinned tunnel identity and log retention before enrollment.');
  const cloudOptions=connection(config.cloudMysql),sourceOptions=connection(config.sourceMysql);
  const baselineId=crypto.createHash('sha256').update(JSON.stringify([config.shopId,config.database,config.sourceUuid,config.replicaUuid,config.baselineSha256,config.sourceActivationId,config.sourceGeneration,config.cloudActivationId,config.cloudGeneration,config.sourceDatabasePort,config.cloudDatabasePort])).digest('hex');
  const directory=config.controlDirectory;await fs.mkdir(directory,{recursive:true,mode:0o700});
  const releaseLock = await acquireWorkerLock(directory);
  let cloud,source,timer,wake,stopped=false;
  try{
    cloud=mysql.createPool({...cloudOptions,connectionLimit:1,queueLimit:1,enableKeepAlive:true});
    source=mysql.createPool({...sourceOptions,connectionLimit:1,queueLimit:1,enableKeepAlive:true});
    const withSession=async operation=>{const c=await cloud.getConnection();let destroyed=false;try{return await operation((sql,args)=>c.query({sql,timeout:5000},args));}catch(error){if(error.fatal||error.code==='PROTOCOL_SEQUENCE_TIMEOUT'){destroyed=true;c.destroy();}throw error;}finally{if(!destroyed)c.release();}};
    const authority=()=>verifyNativeAuthority({config});
    const control=createNativeReplicaControl({withSession,config,verifyAuthority:authority});
    const schedule=createCloudSyncSettingsService({configDirectory:directory});
    const stateFile=path.join(directory,'native-run.json'),manualFile=path.join(directory,'native-manual.json');
    async function readManual(){const request=await optionalJson(manualFile);if(request&&(!/^[a-f0-9-]{36}$/.test(request.id||'')||!Number.isFinite(Date.parse(request.requestedAt))))throw Error('Manual request is invalid.');return request;}
    async function clearManual(id){const request=await readManual();if(request?.id===id)await fs.unlink(manualFile);}
    async function getSourceCheckpoint(){
      const [rows]=await source.query({sql:"SHOW GLOBAL VARIABLES WHERE Variable_name IN ('server_uuid','log_bin','binlog_format','binlog_row_image','binlog_expire_logs_seconds')",timeout:5000});
      const flags=Object.fromEntries(rows.map(row=>[row.Variable_name,row.Value]));
      if(flags.server_uuid!==config.sourceUuid||flags.log_bin!=='ON'||flags.binlog_format!=='ROW'||flags.binlog_row_image!=='FULL'||Number(flags.binlog_expire_logs_seconds)<config.minimumLogRetentionDays*86400)throw Error('The local source identity or binary-log policy changed.');
      const [status]=await source.query({sql:'SHOW MASTER STATUS',timeout:5000});const point=status[0];
      if(!point||String(point.Binlog_Ignore_DB||'').trim()||(String(point.Binlog_Do_DB||'').trim()&&point.Binlog_Do_DB!==config.database))throw Error('Source log filters do not cover the pinned POS database.');
      return coordinate({file:point.File,position:Number(point.Position)});
    }
    const agent=createNativeReplicaAgent({control,baselineId,loadSchedule:schedule.loadScheduleRecord,verifyAuthority:authority,
      readState:()=>optionalJson(stateFile),saveState:value=>writeReplicaStatus(stateFile,value),getSourceCheckpoint,readManual,clearManual,
      audit:(status,job)=>appendSyncEvent(directory,status,Date.now(),(job.manualId?'manual:':'daily:')+job.id),
      writeStatus:value=>writeReplicaStatus(path.join(directory,'native-status.json'),value)});
    const stop=()=>{stopped=true;if(timer)clearTimeout(timer);wake?.();};process.once('SIGTERM',stop);process.once('SIGINT',stop);
    while(!stopped){await agent.tick();if(!stopped)await new Promise(resolve=>{wake=resolve;timer=setTimeout(resolve,5000);});wake=null;}
    // Do not leave an unfinished SQL applier running merely because this controller stopped.
    await control.pause();
  }finally{if(cloud)await cloud.end();if(source)await source.end();await releaseLock();}
}
main().catch(error=>{console.error('Native daily sync agent stopped: '+(error.code||error.message));process.exitCode=1;});
