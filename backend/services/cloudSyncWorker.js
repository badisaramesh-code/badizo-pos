const crypto=require('node:crypto');
const {validateConfig,nextScheduledAt}=require('./cloudSyncSettingsService');
function unavailable(){const error=Error('Cloud sync is not configured or currently permitted.');error.status=409;return error;}

// SQL state and the outbox survive restart. No timers or DDL run on import.
// canTransfer must check enrollment, baseline/domain support and authority.
function createCloudSyncWorker({pool,identity,getSchedule,flush,canTransfer=async()=>false,clock=()=>Date.now(),batchSize=10,audit=async()=>{}}){
  if(!/^[A-Z][A-Z0-9_-]{2,31}$/.test(identity?.shopId||'') || !/^[A-Za-z0-9_-]{3,64}$/.test(identity?.localInstallationId||'')
    || typeof getSchedule!=='function' || typeof flush!=='function' || !Number.isInteger(batchSize) || batchSize<1 || batchSize>100)throw Error('Invalid sync worker configuration.');
  // Optional per-installation status file for the owner dashboard. A run can span several batches.
  const statusFile = process.env.BADIZO_SYNC_STATUS_PATH;
  async function report(phase, time) {
    if (!statusFile || !require('node:path').isAbsolute(statusFile)) return;
    const fs = require('node:fs/promises');
    try {
      const previous = await fs.readFile(statusFile,'utf8').then(JSON.parse).catch(()=>({}));
      const started = previous.started && ['running','failed'].includes(previous.status) ? previous.started : time;
      const snapshot = {status:phase, started, lastSuccessAt:previous.lastSuccessAt||null, durationMs:previous.durationMs??null};
      if (phase==='success') { snapshot.lastSuccessAt=new Date(time).toISOString(); snapshot.durationMs=Math.max(0,time-started); }
      if (phase==='running' && previous.status==='running') return;
      await fs.mkdir(require('node:path').dirname(statusFile),{recursive:true});
      const tmp=statusFile+'.'+process.pid+'.tmp';
      await fs.writeFile(tmp,JSON.stringify(snapshot));await fs.rename(tmp,statusFile);
    } catch { /* Monitoring never stops sync. */ }
  }
  const key=[identity.shopId,identity.localInstallationId];
  const lock='badizo-worker-'+crypto.createHash('sha256').update(JSON.stringify(key)).digest('hex').slice(0,40);
  let active=false,timer=null;
  async function ensure(connection){await connection.execute('INSERT IGNORE INTO sync_worker_state (shop_id,installation_id) VALUES (?,?)',key);}
  async function read(connection){const [rows]=await connection.execute('SELECT * FROM sync_worker_state WHERE shop_id=? AND installation_id=?',key);return rows[0];}
  async function status(){
    if(await canTransfer()!==true)return {ready:false,state:'not-configured',lastSuccessAt:null,nextRunAt:null};
    const row=await read(pool);
    const schedule=await getSchedule();
    const config=validateConfig(schedule.config ?? schedule);
    const paused=schedule.transfersPaused || !config.enabled&&!row?.manual_requested&&!active;
    const iso=value=>value==null?null:new Date(Number(value)).toISOString();
    return {ready:true,state:schedule.transfersPaused?'paused':active?'running':paused?'paused':row?.phase||'idle',lastSuccessAt:iso(row?.last_success_ms),nextRunAt:paused?null:iso(row?.retry_at_ms??row?.next_scheduled_ms),manualPending:Boolean(row?.manual_requested),failureCount:Number(row?.failure_count||0)};
  }
  async function record(outcome, time, row) {
    try { await audit(outcome, time, row.manual_requested ? 'Manual' : 'Scheduled'); }
    catch { console.warn('Cloud sync audit write failed.'); }
  }
  async function requestNow(user){
    if(await canTransfer()!==true)throw unavailable();
    await ensure(pool);
    // Repeated clicks coalesce. Do not erase a network retry backoff.
    await pool.execute('UPDATE sync_worker_state SET manual_requested=TRUE,request_generation=request_generation+1,last_requested_by=? WHERE shop_id=? AND installation_id=?',[String(user?.username||'server').slice(0,100),...key]);
    return {accepted:true,...await status()};
  }
  async function tick(){
    if(active)return {skipped:true};
    active=true;let connection,locked=false,discarded=false;
    try{
      if ((await getSchedule()).transfersPaused) return {skipped:true};
      if(await canTransfer()!==true)return {skipped:true};
      connection=await pool.getConnection();
      const [[result]]=await connection.execute('SELECT GET_LOCK(?,0) AS acquired',[lock]);
      if(Number(result.acquired)!==1)return {busy:true};
      locked=true;await ensure(connection);
      const schedule=await getSchedule();
      const config=validateConfig(schedule.config ?? schedule),now=clock();
      if(!Number.isSafeInteger(now)||now<0)throw Error('Invalid worker clock.');
      let row=await read(connection);
      const scheduleKey=JSON.stringify(config);
      if(row.schedule_key!==scheduleKey){
        // The PC can shut down between saving the schedule and this first tick.
        const savedAt = Date.parse(schedule.updatedAt);
        const reference = Number.isFinite(savedAt)
          ? Math.min(now, Math.max(savedAt, Number(row.last_success_ms || 0)))
          : now;
        const next=nextScheduledAt(config,new Date(reference));
        await connection.execute('UPDATE sync_worker_state SET schedule_key=?,next_scheduled_ms=? WHERE shop_id=? AND installation_id=?',[scheduleKey,next?Date.parse(next):null,...key]);
        row={...row,schedule_key:scheduleKey,next_scheduled_ms:next?Date.parse(next):null};
      }
      // Pausing automatic sync also pauses automatic retries. A queued manual
      // request remains eligible, including after a process restart.
      if(schedule.transfersPaused || (!config.enabled && !row.manual_requested))return {skipped:true};
      if(row.retry_at_ms!=null && Number(row.retry_at_ms)>now)return {waiting:true};
      if(!row.manual_requested && row.retry_at_ms==null && (row.next_scheduled_ms==null || Number(row.next_scheduled_ms)>now))return {waiting:true};
      if(await canTransfer()!==true)return {skipped:true};
      await connection.execute("UPDATE sync_worker_state SET phase='running' WHERE shop_id=? AND installation_id=?",key);
      await report('running',now);
      try{
        const result=await flush({limit:batchSize});
        if(result.busy){await connection.execute("UPDATE sync_worker_state SET phase='waiting',retry_at_ms=? WHERE shop_id=? AND installation_id=?",[clock()+30000,...key]);return result;}
        if(!Number.isInteger(result.acknowledged)||result.acknowledged<0||result.acknowledged>batchSize*2
          || (Object.hasOwn(result,'hasMore')&&typeof result.hasMore!=='boolean'))throw Error('Invalid sender result.');
        if(result.hasMore===true || (!Object.hasOwn(result,'hasMore')&&result.acknowledged===batchSize)){
          await connection.execute("UPDATE sync_worker_state SET phase='pending',retry_at_ms=?,failure_count=0 WHERE shop_id=? AND installation_id=?",[clock()+1000,...key]);
        }else{
          const finished=clock(),next=nextScheduledAt(config,new Date(finished));
          await connection.execute("UPDATE sync_worker_state SET phase='idle',retry_at_ms=NULL,failure_count=0,manual_requested=(request_generation<>?),last_success_ms=?,next_scheduled_ms=? WHERE shop_id=? AND installation_id=?",[String(row.request_generation),finished,next?Date.parse(next):null,...key]);
          await report('success',finished);
          await record('Completed',finished,row);
        }
        return result;
      }catch(error){
        const attempts=Math.min(Number(row.failure_count)+1,1000000);
        const delay=Math.min(30*60000,30000*2**Math.min(attempts-1,6));
        await connection.execute("UPDATE sync_worker_state SET phase='retrying',failure_count=?,retry_at_ms=? WHERE shop_id=? AND installation_id=?",[attempts,clock()+delay,...key]);
        // Never persist or expose transport credentials, SQL or remote body text.
        await report('failed',clock());
        await record('Failed; retry scheduled',clock(),row);
        return {failed:true,retryAfterMs:delay};
      }
    }finally{
      if(locked){try{await connection.execute('SELECT RELEASE_LOCK(?)',[lock]);}catch{connection.destroy();discarded=true;}}
      if(connection&&!discarded)connection.release();active=false;
    }
  }
  function start(){if(timer)return;timer=setInterval(()=>{tick().catch(()=>{});},15000);timer.unref();tick().catch(()=>{});}
  function stop(){if(timer)clearInterval(timer);timer=null;}
  return {status,requestNow,tick,start,stop};
}
module.exports={createCloudSyncWorker};
