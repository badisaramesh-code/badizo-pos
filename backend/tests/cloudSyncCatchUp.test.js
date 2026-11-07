const test = require('node:test');
const assert = require('node:assert/strict');
const {createCloudSyncWorker} = require('../services/cloudSyncWorker');
const config = {enabled:true, frequency:'daily', dailyTime:'20:30', timezone:'Asia/Kolkata'};
const morning = Date.parse('2026-11-07T03:30:00Z');
for (const scenario of [
  {name:'saved before shutdown, first tick next morning',row:{},saved:'2026-11-06T13:00:00Z',runs:1},
  {name:'previously scheduled missed night',row:{schedule_key:JSON.stringify(config),next_scheduled_ms:morning-3600000},runs:1},
  {name:'new schedule enabled this morning',row:{},saved:new Date(morning).toISOString(),runs:0}
]) test(scenario.name, async () => {
  const row={request_generation:0,...scenario.row};
  const connection={release(){},async execute(sql,args){
    if(sql.startsWith('SELECT GET_LOCK'))return [[{acquired:1}]];
    if(sql.startsWith('SELECT *'))return [[row]];
    if(sql.includes('SET schedule_key='))Object.assign(row,{schedule_key:args[0],next_scheduled_ms:args[1]});
    if(sql.includes("phase='idle'"))Object.assign(row,{last_success_ms:args[1],next_scheduled_ms:args[2]});
    return [{}];
  }};
  let runs=0;
  const worker=createCloudSyncWorker({pool:{getConnection:async()=>connection},identity:{shopId:'HFM001',localInstallationId:'local-1'},
    getSchedule:async()=>({config,updatedAt:scenario.saved}),canTransfer:async()=>true,clock:()=>morning,
    flush:async()=>{runs++;return {acknowledged:0,hasMore:false};}});
  await worker.tick(); await worker.tick();
  assert.equal(runs,scenario.runs);
  assert.equal(row.next_scheduled_ms,Date.parse('2026-11-07T15:00:00Z'));
});
