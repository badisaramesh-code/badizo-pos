const crypto=require('node:crypto');
const {validateEvent}=require('./syncEventProtocol');
// Call within the SAME caller-owned transaction as the business operation.
// This helper never opens or commits a transaction on the caller's behalf.
async function enqueue(connection,event,identity){
  const checked=validateEvent(event,{shopId:identity.shopId,peerInstallationId:identity.localInstallationId,localInstallationId:identity.peerInstallationId});
  await connection.execute('INSERT INTO sync_outbox (event_id,shop_id,origin_installation_id,event_json,payload_hash) VALUES (?,?,?,?,?)',[event.eventId,event.shopId,event.originInstallationId,checked.serialized,checked.hash]);
}
function createOutboxSender({pool,identity,send}){
  if(typeof send!=='function')throw Error('Authenticated transport required.');
  const lock='badizo-sync-'+crypto.createHash('sha256').update(JSON.stringify(identity)).digest('hex').slice(0,40);
  return async function flush({limit=100}={}){
    if(!Number.isInteger(limit)||limit<1||limit>1000)throw Error('Invalid batch size.');
    const connection=await pool.getConnection();let locked=false;
    try{
      const [rows]=await connection.execute('SELECT GET_LOCK(?,0) AS acquired',[lock]);
      if(Number(rows[0].acquired)!==1)return {busy:true,acknowledged:0};
      locked=true;
      const [pending]=await connection.execute('SELECT event_id,event_json,payload_hash FROM sync_outbox WHERE shop_id=? AND origin_installation_id=? AND acknowledged_at IS NULL ORDER BY (JSON_UNQUOTE(JSON_EXTRACT(event_json,\'$.type\'))=\'pos.recovery.product-resolved\') DESC,sequence_no LIMIT '+limit,[identity.shopId,identity.localInstallationId]);
      let acknowledged=0;
      for(const row of pending){
        const event=typeof row.event_json==='string'?JSON.parse(row.event_json):row.event_json;
        const checked=validateEvent(event,{shopId:identity.shopId,peerInstallationId:identity.localInstallationId,localInstallationId:identity.peerInstallationId});
        if(checked.hash!==row.payload_hash || event.eventId!==row.event_id)throw Error('Outgoing event failed integrity verification.');
        const result=await send(event);
        if(result?.eventId!==event.eventId || result.committed!==true)throw Error('Receiver did not acknowledge a committed event.');
        await connection.execute('UPDATE sync_outbox SET acknowledged_at=CURRENT_TIMESTAMP(6) WHERE event_id=? AND shop_id=? AND origin_installation_id=? AND acknowledged_at IS NULL',[event.eventId,identity.shopId,identity.localInstallationId]);
        acknowledged++;
      }
      return {busy:false,acknowledged};
    }finally{
      let discarded=false;
      if(locked){try{await connection.execute('SELECT RELEASE_LOCK(?)',[lock]);}catch{connection.destroy();discarded=true;}}
      if(!discarded)connection.release();
    }
  };
}
module.exports={enqueue,createOutboxSender};
