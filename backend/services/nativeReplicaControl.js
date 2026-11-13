'use strict';
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
function validateReplicaConfig(value){
  if(!value||!/^[A-Z][A-Z0-9_-]{2,31}$/.test(value.shopId||'')||!/^[A-Za-z0-9_-]{1,64}$/.test(value.channel||'')||
    !/^[A-Za-z0-9_]{1,64}$/.test(value.database||'')||!UUID.test(value.sourceUuid||'')||!UUID.test(value.replicaUuid||'')||
    value.sourceUuid===value.replicaUuid||!/^[a-f0-9]{64}$/.test(value.baselineSha256||'')||value.baselineRestoreVerified!==true||
    !/^[A-Za-z0-9_]{1,32}$/.test(value.applierUser||'')||!['localhost','127.0.0.1','::1'].includes(value.applierHost))
    throw Error('Pin the shop, source, cloud replica, channel and restore-verified baseline.');
  return Object.fromEntries(['shopId','channel','database','sourceUuid','replicaUuid','baselineSha256','baselineRestoreVerified','applierUser','applierHost'].map(key=>[key,value[key]]));
}
function coordinate(value){
  const match=/^([A-Za-z0-9_-]+)\.(\d{6})$/.exec(value?.file||'');
  if(!match||!Number.isSafeInteger(value.position)||value.position<4)throw Error('Invalid source binary-log coordinate.');
  return {file:value.file,position:value.position,prefix:match[1],number:Number(match[2])};
}
function compareCoordinates(a,b){a=coordinate(a);b=coordinate(b);if(a.prefix!==b.prefix)throw Error('Binary-log sequence changed; baseline review required.');return a.number===b.number?Math.sign(a.position-b.position):Math.sign(a.number-b.number);}
function createNativeReplicaControl({query,withSession=operation=>operation(query),config,verifyAuthority=async()=>false,isCommitted}){
  const pinned=validateReplicaConfig(config),channel="'"+pinned.channel+"'",lock='badizo-native:'+pinned.shopId;
  async function inspectUsing(q){
    const [identity]=await q('SELECT @@server_uuid AS server_uuid, @@read_only AS read_only, @@super_read_only AS super_read_only');
    const node=identity[0];
    if(!node||node.server_uuid!==pinned.replicaUuid||node.server_uuid===pinned.sourceUuid)throw Error('Cloud MySQL identity differs from the verified replica.');
    if(Number(node.read_only)!==1||Number(node.super_read_only)!==1)throw Error('Cloud may be billing; replication control is blocked.');
    const [variables]=await q("SHOW GLOBAL VARIABLES WHERE Variable_name IN ('skip_slave_start','skip_replica_start','replica_parallel_workers','partial_revokes')");
    const flags=Object.fromEntries(variables.map(row=>[row.Variable_name,row.Value]));
    if(!['ON','1'].includes(String(flags.skip_replica_start??flags.skip_slave_start))||Number(flags.replica_parallel_workers)!==0)
      throw Error('Daily replication requires skip-replica-start and one SQL applier.');
    if(flags.partial_revokes!=='OFF')throw Error('This reviewed privilege profile requires partial_revokes=OFF.');
    const [channels]=await q('SHOW REPLICA STATUS');
    if(channels.length!==1)throw Error('Exactly one reviewed replication channel is required.');
    const row=channels[0];
    if(row.Source_UUID!==pinned.sourceUuid||row.Channel_Name!==pinned.channel||Number(row.Auto_Position)!==0)throw Error('Source identity, channel or baseline mode changed.');
    const wildcard=pinned.database.replace(/_/g,'\\_')+'.%';
    if(row.Replicate_Wild_Do_Table!==wildcard||[row.Replicate_Ignore_DB,row.Replicate_Ignore_Table,row.Replicate_Do_Table,row.Replicate_Wild_Ignore_Table,row.Replicate_Rewrite_DB].some(v=>String(v||'').trim())||
      row.Replicate_Do_DB!==pinned.database)throw Error('Filters do not cover only the entire pinned POS database.');
    const [security]=await q('SELECT PRIVILEGE_CHECKS_USER, REQUIRE_ROW_FORMAT, REQUIRE_TABLE_PRIMARY_KEY_CHECK FROM performance_schema.replication_applier_configuration WHERE CHANNEL_NAME = ?',[pinned.channel]);
    const secured=security[0],account=pinned.applierUser+'@'+pinned.applierHost;
    if(security.length!==1||String(secured?.PRIVILEGE_CHECKS_USER||'').replace(/['`]/g,'')!==account||
      !['YES','ON','1'].includes(String(secured.REQUIRE_ROW_FORMAT).toUpperCase())||secured.REQUIRE_TABLE_PRIMARY_KEY_CHECK!=='OFF')
      throw Error('A pinned row-only restricted replication applier is required.');
    const [grants]=await q("SHOW GRANTS FOR '"+pinned.applierUser+"'@'"+pinned.applierHost+"'");
    for(const grant of grants){
      const text=String(Object.values(grant)[0]),match=/^GRANT (.+) ON (.+) TO /i.exec(text);
      if(!match||/GRANT OPTION/i.test(text))throw Error('Unreviewed inherited or grantable applier privileges.');
      const scope=match[2].replace(/`/g,'');
      if(scope==='*.*'&&match[1].split(',').some(priv=>!['USAGE','REPLICATION_APPLIER'].includes(priv.trim().toUpperCase())))throw Error('Replication applier has unsafe global privileges.');
      // SHOW GRANTS escapes the grant-pattern backslash again in its SQL identifier.
      const exactScope=pinned.database.replace(/_/g,'\\_')+'.*';
      if(scope!=='*.*'&&scope!==exactScope)throw Error('Replication applier can access another database or a database-name wildcard.');
    }
    const received={file:row.Source_Log_File,position:Number(row.Read_Source_Log_Pos)},applied={file:row.Relay_Source_Log_File,position:Number(row.Exec_Source_Log_Pos)};
    coordinate(received);coordinate(applied);
    return {ready:true,receiver:row.Replica_IO_Running,applier:row.Replica_SQL_Running,received,applied,
      until:row.Until_Condition==='Source'?{file:row.Until_Log_File,position:Number(row.Until_Log_Pos)}:null,
      lagSeconds:row.Seconds_Behind_Source==null?null:Number(row.Seconds_Behind_Source),ioError:Number(row.Last_IO_Errno||0),sqlError:Number(row.Last_SQL_Errno||0)};
  }
  async function guarded(operation){return withSession(async q=>{
    const [rows]=await q('SELECT GET_LOCK(?, 0) AS acquired',[lock]);
    if(Number(rows[0]?.acquired)!==1)throw Object.assign(Error('Cloud maintenance is active; replication is waiting.'),{code:'NATIVE_MAINTENANCE_BUSY'});
    try{return await operation(q);}finally{await q('SELECT RELEASE_LOCK(?) AS released',[lock]);}
  });}
  async function stopUsing(q,status){
    if(status.receiver!=='No'||status.applier!=='No')await q('STOP REPLICA FOR CHANNEL '+channel);
    const stopped=await inspectUsing(q);
    if(stopped.receiver!=='No'||stopped.applier!=='No')throw Error('Replica stop is not yet confirmed.');
    return stopped;
  }
  async function pause(){return guarded(async q=>stopUsing(q,await inspectUsing(q)));}
  async function startUntil(target){target=coordinate(target);return guarded(async q=>{
    if(await verifyAuthority()!==true)throw Error('Local or cloud authority/baseline changed.');
    let status=await inspectUsing(q);
    if(status.sqlError||status.ioError===1236)throw Error('Replication gap or SQL error requires inspection; no reset or skipping is permitted.');
    if(compareCoordinates(status.applied,target)>0)throw Error('Cloud applied beyond the managed target; baseline review is required.');
    if(compareCoordinates(status.applied,target)===0)return stopUsing(q,status);
    if(status.applier==='Yes'&&status.until&&compareCoordinates(status.until,target)===0)return status;
    status=await stopUsing(q,status);
    // UNTIL is applied by MySQL at a transaction boundary, independently of polling latency.
    await q('START REPLICA IO_THREAD FOR CHANNEL '+channel);
    await q('START REPLICA SQL_THREAD UNTIL SOURCE_LOG_FILE = '+"'"+target.file+"'"+', SOURCE_LOG_POS = '+target.position+' FOR CHANNEL '+channel);
    return inspectUsing(q);
  });}
  async function withRecoveryFence(operation){
    if(typeof operation!=='function'||typeof isCommitted!=='function')throw Error('Trusted recovery and durable activation-proof callbacks are required.');
    return guarded(async q=>{
      const replica=await stopUsing(q,await inspectUsing(q));
      try{return await operation({query:q,pinned:{...pinned},replica});}
      catch(error){
        let committed;
        try{committed=await isCommitted(error);}catch{throw Object.assign(Error('Recovery commit state could not be proved. Preserve both databases and inspect the standby flags.'),{recoveryRequired:true});}
        if(committed===true){error.commitVerified=true;throw error;}
        if(committed!==false)throw Object.assign(Error('Recovery commit state is unknown; automatic refencing is blocked.'),{recoveryRequired:true});
        try{
          await q('SET GLOBAL read_only=ON');await q('SET GLOBAL super_read_only=ON');
          const [rows]=await q('SELECT @@server_uuid AS server_uuid, @@read_only AS read_only, @@super_read_only AS super_read_only');
          if(rows[0]?.server_uuid!==pinned.replicaUuid||Number(rows[0]?.read_only)!==1||Number(rows[0]?.super_read_only)!==1)throw Error('Standby flags are unconfirmed.');
        }catch{throw Object.assign(Error('Failed recovery could not restore the cloud standby flags. Billing must remain fenced for inspection.'),{recoveryRequired:true});}
        throw error;
      }
    });
  }
  return {inspect:()=>withSession(inspectUsing),pause,startUntil,withRecoveryFence};
}
async function withNativeRecoveryFence(options,operation){return createNativeReplicaControl(options).withRecoveryFence(operation);}
module.exports={validateReplicaConfig,coordinate,compareCoordinates,createNativeReplicaControl,withNativeRecoveryFence};
