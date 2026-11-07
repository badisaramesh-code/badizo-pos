const crypto=require('node:crypto');
const {validateEvent}=require('./syncEventProtocol');
function createSyncPullClient({pool,identity,url,token,receive,mayApply=async()=>false,timeoutMs=20000,baselineId=null}){
  const base=new URL(url);
  if(base.protocol!=='https:'||base.username||base.password||base.search||base.hash)throw Error('Pull requires a clean HTTPS endpoint.');
  if(typeof token!=='string'||!/^[a-f0-9]{64,128}$/.test(token)||typeof receive!=='function')throw Error('Authenticated pull configuration required.');
  if(!Number.isInteger(timeoutMs)||timeoutMs<100||timeoutMs>60000)throw Error('Invalid pull timeout.');
  const lock='badizo-pull-'+crypto.createHash('sha256').update(JSON.stringify(identity)).digest('hex').slice(0,40);
  async function request(suffix,body){
    const response=await fetch(base.href.replace(/\/$/,'')+suffix,{method:body?'POST':'GET',redirect:'error',signal:AbortSignal.timeout(timeoutMs),headers:{Authorization:'Bearer '+token,...(baselineId?{'X-Badizo-Baseline':baselineId}:{}),...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});
    if(!response.ok){await response.body?.cancel();throw Error('Cloud update request failed.');}
    const reader=response.body.getReader(),chunks=[];let length=0;
    try{for(;;){const {done,value}=await reader.read();if(done)break;length+=value.length;if(length>(body?16384:2*1024*1024))throw Error('Cloud update response exceeds limit.');chunks.push(Buffer.from(value));}}
    catch(error){await reader.cancel().catch(()=>{});throw error;}finally{reader.releaseLock();}
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  }
  return async function pull({limit=10}={}){
    if(!Number.isInteger(limit)||limit<1||limit>100)throw Error('Invalid pull batch size.');
    if(await mayApply()!==true)throw Error('Applying cloud changes is currently blocked.');
    const connection=await pool.getConnection();let locked=false,discarded=false;
    try{
      const [[result]]=await connection.execute('SELECT GET_LOCK(?,0) AS acquired',[lock]);
      if(Number(result.acquired)!==1)return {busy:true,acknowledged:0};locked=true;
      const response=await request('/pending');
      if(!response || Object.keys(response).sort().join(',')!=='events,hasMore'||typeof response.hasMore!=='boolean'||!Array.isArray(response.events)||response.events.length>10)throw Error('Invalid cloud update list.');
      let acknowledged=0;
      for(const entry of response.events.slice(0,limit)){
        if(!entry || Object.keys(entry).sort().join(',')!=='event,hash')throw Error('Invalid cloud update.');
        const checked=validateEvent(entry.event,identity);
        if(checked.hash!==entry.hash)throw Error('Cloud update integrity check failed.');
        if(await mayApply()!==true)throw Error('Applying cloud changes is currently blocked.');
        const committed=await receive(entry.event);
        if(committed?.committed!==true||committed.eventId!==entry.event.eventId)throw Error('Local database did not commit the cloud update.');
        // If this call fails after the local commit, redelivery is recognized by
        // sync_inbox. Never acknowledge first or echo incoming changes outward.
        const ack=await request('/ack',{eventId:entry.event.eventId,hash:entry.hash});
        if(ack?.acknowledged!==true||ack.eventId!==entry.event.eventId)throw Error('Cloud did not confirm the acknowledgment.');
        acknowledged++;
      }
      return {busy:false,acknowledged,hasMore:response.hasMore||response.events.length>limit};
    }finally{
      if(locked){try{await connection.execute('SELECT RELEASE_LOCK(?)',[lock]);}catch{connection.destroy();discarded=true;}}
      if(!discarded)connection.release();
    }
  };
}
module.exports={createSyncPullClient};
