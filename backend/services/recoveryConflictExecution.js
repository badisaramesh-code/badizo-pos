const crypto = require('node:crypto');
const { normalize } = require('./productSyncHandler');
const { enqueue } = require('./syncOutbox');
const {fieldEvent,receipt}=require('./productConflictResolution');
const {validateEvent}=require('./syncEventProtocol');

// Executes only reviewed product name/price choices. Stock and financial
// differences must never be converted into last-writer-wins updates.
function createRecoveryConflictExecution({ pool, store, identity, canApply = async () => false }) {
  async function status(planId, connection = pool) {
    const [rows] = await connection.execute('SELECT revision,head_hash,actor,applied_at FROM sync_recovery_applications WHERE shop_id=? AND plan_id=?', [identity.shopId, planId]);
    return rows[0] || null;
  }
  async function assertMutable(planId) {
    if (await status(planId)) throw Error('This review has already been applied. Create a new review for later changes.');
  }
  async function apply(planId, { expectedRevision, expectedHeadHash, actor }) {
    if (!Number.isSafeInteger(expectedRevision) || typeof actor !== 'string' || !actor.trim() || !/^[a-f0-9]{64}$/.test(expectedHeadHash || '')) throw Error('A saved review revision and signed-in owner are required.');
    return store.exclusive(planId, async () => {
      const review = await store.read(planId);
      if (review.plan.shopId !== identity.shopId || review.revision !== expectedRevision || review.headHash !== expectedHeadHash) throw Error('Review changed; reload before applying.');
      if (review.unresolvedConflictIds.length) throw Error('Resolve every conflict before applying this review.');
      const decisions = new Map(review.decisions.map(item => [item.conflictId, item]));
      const groups = new Map();
      for (const entry of review.plan.entries) {
        if (entry.state === 'equal') continue;
        if (entry.kind !== 'product' || !['product_name', 'sale_price'].includes(entry.field)) throw Error('This review includes stock or financial changes requiring separate reconciliation.');
        const chosen = entry.state === 'conflict' ? decisions.get(entry.id)?.chosenValue : entry.value;
        const value = normalize(entry.field, chosen);
        const change = { field: entry.field, local: normalize(entry.field, entry.local), cloud: normalize(entry.field, entry.cloud), value };
        if (!groups.has(entry.recordId)) groups.set(entry.recordId, []);
        groups.get(entry.recordId).push(change);
      }
      const connection = await pool.getConnection();
      let begun = false;
      try {
        await connection.beginTransaction(); begun = true;
        const existing = await status(planId, connection);
        if (existing) {
          if (Number(existing.revision) !== expectedRevision || existing.head_hash !== expectedHeadHash) throw Error('A different revision was already applied.');
          await connection.commit(); begun = false;
          return { applied: true, duplicate: true, safeToResumeLocal: false };
        }
        if (await canApply() !== true) throw Error('Recovery application is not enabled for this installation.');
        const [pending]=await connection.execute('SELECT event_json,payload_hash FROM sync_outbox WHERE shop_id=? AND origin_installation_id=? AND acknowledged_at IS NULL ORDER BY sequence_no LIMIT 1001 FOR UPDATE',[identity.shopId,identity.localInstallationId]);
        if(pending.length>1000)throw Error('Too many pending events for one recovery review.');
        const superseded=new Map();
        for(const row of pending){
          const event=typeof row.event_json==='string'?JSON.parse(row.event_json):row.event_json;
          const fields=fieldEvent(event);
          if(!fields||!groups.has(fields.barcode))continue;
          const reviewed=groups.get(fields.barcode);
          if(fields.changes.some(change=>!reviewed.some(item=>item.field===change.field)))throw Error('Pending product changes are outside this review.');
          const checked=validateEvent(event,{shopId:identity.shopId,peerInstallationId:identity.localInstallationId,localInstallationId:identity.peerInstallationId});
          if(checked.hash!==row.payload_hash)throw Error('Pending event integrity check failed.');
          if(!superseded.has(fields.barcode))superseded.set(fields.barcode,[]);
          superseded.get(fields.barcode).push(event);
        }
        // Validate all rows first. An edit made since preview invalidates the
        // operation instead of overwriting fresh cashier/owner work.
        for (const [barcode, changes] of [...groups].sort(([a], [b]) => a.localeCompare(b))) {
          const [rows] = await connection.execute('SELECT product_name,sale_price FROM products WHERE barcode=? FOR UPDATE', [barcode]);
          if (rows.length !== 1 || changes.some(change => normalize(change.field, rows[0][change.field]) !== change.local)) throw Error('Local product changed since review; prepare a fresh review.');
        }
        for (const [barcode, changes] of groups) {
          const local = changes.filter(change => change.local !== change.value);
          if (local.length) await connection.execute('UPDATE products SET ' + local.map(change => '`' + change.field + '`=?').join(',') + ',updated_at=CURRENT_TIMESTAMP WHERE barcode=?', [...local.map(change => change.value), barcode]);
          // The peer checks its own reviewed value, not this server's value.
          // If cloud changed again, delivery stops for a fresh review.
          const covered=superseded.get(barcode)||[];
          const remote = changes.map(change => ({ field: change.field, before: change.cloud, after: change.value }));
          if (covered.length || changes.some(change=>change.cloud!==change.value)) await enqueue(connection, { eventId: crypto.randomUUID(), shopId: identity.shopId, originInstallationId: identity.localInstallationId, type: 'pos.recovery.product-resolved', schemaVersion: 1, payload: { barcode, changes: remote, supersededEvents:covered } }, identity);
        }
        for(const event of review.plan.sourceEvents||[]){
          const fields=fieldEvent(event);
          if(!fields||!groups.has(fields.barcode)||fields.changes.some(change=>!review.plan.entries.some(entry=>entry.recordId===fields.barcode&&entry.field===change.field&&normalize(change.field,entry.base)===normalize(change.field,change.before)&&normalize(change.field,entry.cloud)===normalize(change.field,change.after))))throw Error('Incoming conflict event does not match this review.');
          await receipt(connection,event,{shopId:identity.shopId,peerInstallationId:identity.peerInstallationId,localInstallationId:identity.localInstallationId});
        }
        await connection.execute('INSERT INTO sync_recovery_applications (shop_id,plan_id,revision,head_hash,actor,review_json) VALUES (?,?,?,?,?,?)', [identity.shopId, planId, expectedRevision, expectedHeadHash, actor, JSON.stringify(review)]);
        await connection.commit(); begun = false;
        return { applied: true, duplicate: false, safeToResumeLocal: false };
      } catch (error) {
        if (begun) await connection.rollback().catch(() => {});
        throw error;
      } finally { connection.release(); }
    });
  }
  return { apply, status, assertMutable };
}
module.exports = { createRecoveryConflictExecution };
