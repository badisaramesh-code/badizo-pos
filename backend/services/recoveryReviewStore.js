const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { createPlan, resolveProductConflicts } = require('./recoveryMergePolicy');
const digest = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fail = message => { throw Error(message); };

// Separate from billing storage. Immutable numbered records are published with
// an exclusive hard link so two processes cannot accept the same revision.
// Use a local filesystem with hard-link support, not a Drive/network folder.
function createRecoveryReviewStore({ directory, shopId, clock = () => new Date().toISOString() }) {
  if (!path.isAbsolute(directory || '') || !/^[A-Z][A-Z0-9_-]{2,31}$/.test(shopId || '')) fail('Explicit recovery directory and shop identity required.');
  const root = path.join(directory, shopId);
  function location(id) {
    if (!/^[a-f0-9]{64}$/.test(id || '')) fail('Invalid recovery plan ID.');
    return path.join(root, id);
  }
  async function publish(id, revision, payload) {
    const folder = location(id);
    await fs.mkdir(folder, { recursive: true, mode: 0o700 });
    const temporary = path.join(folder, `${crypto.randomUUID()}.pending`);
    const record = { ...payload, hash: digest(payload) };
    try {
      const file = await fs.open(temporary, 'wx', 0o600);
      try { await file.writeFile(JSON.stringify(record)); await file.sync(); } finally { await file.close(); }
      await fs.link(temporary, path.join(folder, `${revision}.json`));
    } catch (error) {
      if (error.code === 'EEXIST') fail('Recovery review changed. Refresh before saving.');
      throw error;
    } finally { await fs.unlink(temporary).catch(() => {}); }
  }
  async function read(id) {
    const folder = location(id);
    const revisions = (await fs.readdir(folder)).filter(name => /^\d+\.json$/.test(name)).map(name => Number(name.slice(0,-5))).sort((a,b)=>a-b);
    if (!revisions.length || revisions.some((number,index)=>number !== index)) fail('Incomplete recovery history.');
    let plan, previousHash = null;
    const history = [], chosen = new Map();
    for (const revision of revisions) {
      const record = JSON.parse(await fs.readFile(path.join(folder, `${revision}.json`), 'utf8'));
      const { hash, ...payload } = record;
      if (digest(payload) !== hash || payload.previousHash !== previousHash || payload.revision !== revision || payload.shopId !== shopId || payload.planId !== id) fail('Invalid recovery history.');
      if (revision === 0) {
        plan = payload.plan;
        const rebuilt = createPlan({ ...plan, fields: plan.entries });
        if (rebuilt.id !== id || JSON.stringify(rebuilt) !== JSON.stringify(plan)) fail('Invalid recovery baseline.');
      } else {
        const result = resolveProductConflicts(plan, payload.selection);
        for (const decision of result.decisions) chosen.set(decision.conflictId, decision);
        history.push({ revision, ...result });
      }
      previousHash = hash;
    }
    return { plan, revision: revisions.length - 1, headHash: previousHash, history,
      decisions: [...chosen.values()], unresolvedConflictIds: plan.entries.filter(entry => entry.state === 'conflict' && !chosen.has(entry.id)).map(entry => entry.id),
      applied: false, safeToResumeLocal: false };
  }
  async function create(input) {
    if (input.shopId !== shopId) fail('Shop identity mismatch.');
    const plan = createPlan(input);
    await publish(plan.id, 0, { revision: 0, previousHash: null, shopId, planId: plan.id, plan });
    return read(plan.id);
  }
  async function select(id, { expectedRevision, side, actor, conflictIds }) {
    const current = await read(id);
    if (!Number.isSafeInteger(expectedRevision) || current.revision !== expectedRevision) fail('Recovery review changed. Refresh before saving.');
    const selection = { expectedPlanId: id, side, actor, conflictIds, at: clock() };
    resolveProductConflicts(current.plan, selection);
    await publish(id, expectedRevision + 1, { revision: expectedRevision + 1, previousHash: current.headHash, shopId, planId: id, selection });
    return read(id);
  }
  async function list() {
    let names;
    try { names = await fs.readdir(root); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
    const results = [];
    for (const id of names.filter(name => /^[a-f0-9]{64}$/.test(name)).sort().slice(0,100)) {
      const review = await read(id);
      results.push({ id, revision:review.revision, baselineId:review.plan.baselineId, unresolved:review.unresolvedConflictIds.length });
    }
    return results;
  }
  return { create, read, select, list };
}
module.exports = { createRecoveryReviewStore };
