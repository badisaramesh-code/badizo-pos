const crypto = require('node:crypto');
// Deliberately excludes stock, balances, tax and transaction values.
const BULK_PRODUCT_FIELDS = new Set(['product_name', 'sale_price']);
function scalar(value) {
  return value === null || typeof value === 'string' || typeof value === 'boolean'
    || (typeof value === 'number' && Number.isFinite(value));
}
function compareField({ base, local, cloud }) {
  if (![base, local, cloud].every(scalar)) throw Error('Comparison requires explicit scalar values, including null.');
  if (Object.is(local, cloud)) return { state: 'equal', value: local };
  if (Object.is(local, base)) return { state: 'cloud-only', value: cloud };
  if (Object.is(cloud, base)) return { state: 'local-only', value: local };
  return { state: 'conflict' };
}
function fingerprint(value) { return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
function createPlan({ shopId, baselineId, localCheckpoint, cloudCheckpoint, fields, sourceEvents = [] }) {
  for (const value of [shopId, baselineId, localCheckpoint, cloudCheckpoint]) {
    if (typeof value !== 'string' || !value.trim() || value.length > 200) throw Error('Verified identity and checkpoints are required.');
  }
  if (!Array.isArray(fields) || fields.length > 100000) throw Error('Invalid recovery input.');
  const seen = new Set();
  const entries = fields.map(input => {
    if (!input || !['product', 'financial', 'stock'].includes(input.kind)
      || typeof input.recordId !== 'string' || !input.recordId
      || typeof input.field !== 'string' || !input.field) throw Error('Invalid recovery field.');
    const key = JSON.stringify([input.kind, input.recordId, input.field]);
    if (seen.has(key)) throw Error('Duplicate recovery field.');
    seen.add(key);
    const data = { kind: input.kind, recordId: input.recordId, field: input.field,
      base: input.base, local: input.local, cloud: input.cloud };
    const comparison = compareField(data);
    return { ...data, ...comparison, id: fingerprint(data),
      bulkEligible: comparison.state === 'conflict' && input.kind === 'product' && BULK_PRODUCT_FIELDS.has(input.field) };
  });
  const plan = { schemaVersion: 1, shopId, baselineId, localCheckpoint, cloudCheckpoint, entries };
  if (!Array.isArray(sourceEvents) || sourceEvents.length > 100) throw Error('Invalid conflict source events.');
  if (sourceEvents.length) plan.sourceEvents = JSON.parse(JSON.stringify(sourceEvents));
  return { ...plan, id: fingerprint(plan) };
}
function resolveProductConflicts(plan, { expectedPlanId, side, actor, conflictIds, at = new Date().toISOString() }) {
  const { id, ...body } = plan;
  if (id !== expectedPlanId || fingerprint(body) !== id) throw Error('Recovery preview changed; refresh before resolving.');
  if (!['local', 'cloud'].includes(side)) throw Error('Choose local or cloud.');
  if (typeof actor !== 'string' || !actor.trim() || !Number.isFinite(Date.parse(at))) throw Error('Resolution requires an actor and timestamp.');
  if (!Array.isArray(conflictIds) || !conflictIds.length || new Set(conflictIds).size !== conflictIds.length) throw Error('Select unique conflict IDs.');
  const selected = new Set(conflictIds);
  const eligible = plan.entries.filter(entry => selected.has(entry.id));
  if (eligible.length !== selected.size || eligible.some(entry => !entry.bulkEligible)) throw Error('Only approved product conflicts support this resolution.');
  const decisions = eligible.map(entry => ({ conflictId: entry.id, recordId: entry.recordId, field: entry.field,
    base: entry.base, local: entry.local, cloud: entry.cloud, chosenSide: side, chosenValue: entry[side], actor, at }));
  return { planId: id, shopId: plan.shopId, decisions,
    unresolvedConflictIds: plan.entries.filter(entry => entry.state === 'conflict' && !selected.has(entry.id)).map(entry => entry.id),
    // A resolution document never authorizes a database write or mode change.
    applied: false, safeToResumeLocal: false };
}
module.exports = { compareField, createPlan, resolveProductConflicts };
