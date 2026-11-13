'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {reconcileCloudWriter}=require('../services/reconcileCloudWriter');
const activationId='12345678-1234-4567-89ab-123456789abc';
function fixture({mode='active',operation='operation',running='No',uuid='target',switchAfterCheck=false}={}){
 const database={database:'badizo_recovery_12345678',port:33316,user:'u',password:'p',host:'127.0.0.1'};
 const binding={schemaVersion:1,shopId:'HFM001',phase:'active',billingMode:mode,generation:1,activationId,backupRecoveryOperationId:'operation',nativeReplicationInvalidated:true,reconciliationRequired:true,invoiceEpoch:'00000000000000000000000000',database};
 const history={schemaVersion:1,shopId:'HFM001',generation:1,activationId,operationId:operation};
 const queries=[];let reads=0;
 const read=async file=>{if(file==='binding'){reads++;return reads>1&&switchAfterCheck?{...binding,billingMode:'standby'}:binding;}if(file==='upload')return {shopId:'HFM001',directory:'dir',fenceConfigPath:'fence'};if(file==='fence')return {mysql:{port:33316},native:{shopId:'HFM001',replicaUuid:'target',sourceUuid:'source',channel:'hfm001'}};return history;};
 const open=async()=>({end:async()=>{},query:async sql=>{queries.push(sql);if(sql.includes('GET_LOCK'))return [[{acquired:1}]];if(sql.includes('@@server_uuid'))return [[{uuid,port:33316,ro:1,sro:1}]];if(sql.includes('SHOW REPLICA'))return [[{Channel_Name:'hfm001',Source_UUID:'source',Replica_IO_Running:running,Replica_SQL_Running:'No'}]];return [[{ro:0,sro:0}]];}});
 return {run:()=>reconcileCloudWriter({shopId:'HFM001',bindingPath:'binding',nodeRole:'cloud-standby',uploadRecoveryConfigPath:'upload'},open,read),queries};
}
test('restores only the proved cloud writer after a read-only MySQL reboot',async()=>{const x=fixture();assert.equal(await x.run(),true);assert.deepEqual(x.queries.filter(q=>q.startsWith('SET')),['SET GLOBAL super_read_only=OFF','SET GLOBAL read_only=OFF']);});
test('standby, stale lineage, wrong MySQL, running replication or concurrent pause cannot reopen writes',async()=>{for(const item of [{mode:'standby'},{operation:'previous'},{running:'Yes'},{uuid:'other'},{switchAfterCheck:true}]){const x=fixture(item);assert.equal(await x.run(),false);assert.ok(!x.queries.some(q=>q.startsWith('SET')));}});
