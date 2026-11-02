const crypto = require('node:crypto');
function canonical(value) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && Object.getPrototypeOf(value) === Object.prototype) return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
  throw Error('Sync payload must contain JSON values only.');
}
function validateEvent(event, { shopId, peerInstallationId, localInstallationId }) {
  const keys = ['eventId','shopId','originInstallationId','type','schemaVersion','payload'];
  if (!event || Object.keys(event).length !== keys.length || keys.some(key => !Object.hasOwn(event,key))) throw Error('Invalid sync envelope.');
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(event.eventId)) throw Error('Invalid event identity.');
  if (!/^[A-Z][A-Z0-9_-]{2,31}$/.test(shopId || '')
    || !/^[A-Za-z0-9_-]{3,64}$/.test(peerInstallationId || '')
    || !/^[A-Za-z0-9_-]{3,64}$/.test(localInstallationId || '') || peerInstallationId === localInstallationId
    || event.shopId !== shopId || event.originInstallationId !== peerInstallationId) throw Error('Sync identity mismatch.');
  if (event.schemaVersion !== 1 || !/^[a-z][a-z0-9.-]{2,79}$/.test(event.type)) throw Error('Unsupported event contract.');
  const serialized = canonical(event);
  if (Buffer.byteLength(serialized) > 1024 * 1024) throw Error('Sync event too large.');
  return { serialized, hash: crypto.createHash('sha256').update(serialized).digest('hex') };
}

// Trusted peer identity is supplied by server configuration/authentication,
// never accepted from a request as proof of identity. Handlers must use only
// the supplied transaction connection for all business changes.
function createSyncReceiver({ pool, identity, handlers }) {
  return async function receive(event) {
    const verified = validateEvent(event, identity);
    const handler = Object.hasOwn(handlers, event.type) ? handlers[event.type] : null;
    if (typeof handler !== 'function') throw Error('Unsupported business event.');
    const connection = await pool.getConnection();
    let begun = false;
    try {
      await connection.beginTransaction(); begun = true;
      let duplicate = false;
      try {
        await connection.execute('INSERT INTO sync_inbox (shop_id,event_id,origin_installation_id,payload_hash) VALUES (?,?,?,?)',
          [event.shopId,event.eventId,event.originInstallationId,verified.hash]);
      } catch (error) {
        if (error.code !== 'ER_DUP_ENTRY') throw error;
        const [rows] = await connection.execute('SELECT payload_hash FROM sync_inbox WHERE shop_id=? AND event_id=? FOR UPDATE',[event.shopId,event.eventId]);
        if (rows.length !== 1 || rows[0].payload_hash !== verified.hash) throw Error('Event identity reused with different content.');
        duplicate = true;
      }
      if (!duplicate) await handler(connection, structuredClone(event.payload), { eventId:event.eventId,shopId:event.shopId,originInstallationId:event.originInstallationId });
      await connection.commit(); begun = false;
      return { eventId:event.eventId, committed:true, duplicate };
    } catch (error) {
      if (begun) await connection.rollback().catch(()=>{});
      throw error;
    } finally { connection.release(); }
  };
}
module.exports = { canonical, validateEvent, createSyncReceiver };
