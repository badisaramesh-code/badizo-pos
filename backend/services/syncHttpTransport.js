function createSyncHttpTransport({url,token,timeoutMs=20000}) {
  const target=new URL(url);
  if(target.protocol!=='https:' || target.username || target.password || target.hash || target.search)throw Error('Sync requires a clean HTTPS endpoint.');
  if(typeof token!=='string' || !/^[a-f0-9]{64,128}$/.test(token))throw Error('A dedicated sync credential is required.');
  if(!Number.isInteger(timeoutMs)||timeoutMs<100||timeoutMs>60000)throw Error('Invalid sync timeout.');
  return async function send(event){
    const body=JSON.stringify(event);
    if(Buffer.byteLength(body)>1024*1024)throw Error('Sync event exceeds transport limit.');
    const response=await fetch(target,{method:'POST',redirect:'error',signal:AbortSignal.timeout(timeoutMs),headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body});
    if(!response.ok){await response.body?.cancel();throw Error('Sync receiver rejected this request.');}
    const reader=response.body.getReader();const chunks=[];let length=0;
    try{for(;;){const {done,value}=await reader.read();if(done)break;length+=value.length;if(length>16384)throw Error('Sync acknowledgment exceeds limit.');chunks.push(Buffer.from(value));}}
    catch(error){await reader.cancel().catch(()=>{});throw error;}finally{reader.releaseLock();}
    const result=JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if(result.eventId!==event.eventId || result.committed!==true || typeof result.duplicate!=='boolean')throw Error('Invalid sync acknowledgment.');
    return {eventId:result.eventId,committed:true,duplicate:result.duplicate};
  };
}
module.exports={createSyncHttpTransport};
