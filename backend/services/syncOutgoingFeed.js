const {validateEvent}=require('./syncEventProtocol');
function createOutgoingFeed({pool,identity}){
  const verification={shopId:identity.shopId,peerInstallationId:identity.localInstallationId,localInstallationId:identity.peerInstallationId};
  async function pending(){
    const [rows]=await pool.execute('SELECT event_id,event_json,payload_hash FROM sync_outbox WHERE shop_id=? AND origin_installation_id=? AND acknowledged_at IS NULL ORDER BY (JSON_UNQUOTE(JSON_EXTRACT(event_json,\'$.type\')) IN (\'pos.recovery.product-resolved\',\'pos.recovery.supplier-payment-matched\',\'pos.recovery.stock-deltas-reviewed\')) DESC,sequence_no LIMIT 10',[identity.shopId,identity.localInstallationId]);
    const events=[];let bytes=32;
    for(const row of rows){
      const event=typeof row.event_json==='string'?JSON.parse(row.event_json):row.event_json;
      const checked=validateEvent(event,verification);
      if(checked.hash!==row.payload_hash||event.eventId!==row.event_id)throw Error('Outgoing event failed integrity verification.');
      const entry={event,hash:checked.hash},length=Buffer.byteLength(JSON.stringify(entry))+1;
      if(bytes+length>2*1024*1024)break;
      events.push(entry);bytes+=length;
    }
    return {events,hasMore:events.length<rows.length||rows.length===10};
  }
  async function acknowledge(value){
    if(!value || Object.keys(value).sort().join(',')!=='eventId,hash'
      || !/^[a-f0-9-]{36}$/i.test(value.eventId)||!/^[a-f0-9]{64}$/.test(value.hash))throw Error('Invalid acknowledgment.');
    const args=[value.eventId,identity.shopId,identity.localInstallationId,value.hash];
    // The configured peer may acknowledge only this installation's exact event.
    // This never acknowledges by sequence position or discards subsequent work.
    await pool.execute('UPDATE sync_outbox SET acknowledged_at=COALESCE(acknowledged_at,CURRENT_TIMESTAMP(6)) WHERE event_id=? AND shop_id=? AND origin_installation_id=? AND payload_hash=?',args);
    const [rows]=await pool.execute('SELECT event_id FROM sync_outbox WHERE event_id=? AND shop_id=? AND origin_installation_id=? AND payload_hash=? AND acknowledged_at IS NOT NULL',args);
    if(rows.length!==1)throw Error('Acknowledgment does not match an outgoing event.');
    return {eventId:value.eventId,acknowledged:true};
  }
  return {pending,acknowledge};
}
module.exports={createOutgoingFeed};
