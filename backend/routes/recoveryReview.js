const express = require('express');
const { authenticate, authorize } = require('../middleware/auth');

// Execution is available only with an explicitly configured recovery executor.
function createRouter({ store, shopId, executor = null }) {
  const router = express.Router();
  router.use(authenticate, authorize('SERVER'));
  router.use((_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });
  router.get('/', async (_req,res) => {
    try { res.json({ shopId, reviews:await store.list(), applied:false }); }
    catch(error) { failure(res,error); }
  });
  router.param('planId', (req, res, next, value) => {
    if (!/^[a-f0-9]{64}$/.test(value)) return res.status(400).json({ error: 'Invalid recovery reference.' });
    next();
  });
  async function load(id) {
    const review = await store.read(id);
    if (review.plan.shopId !== shopId) throw Error('Shop mismatch');
    const execution = executor ? await executor.status(id) : null;
    return { ...review, applied: !!execution, execution, canApply: !!executor };
  }
  function failure(res, error) {
    if (error.code === 'ENOENT') return res.status(404).json({ error: 'Recovery review not found.' });
    return res.status(409).json({ error: 'Recovery review unavailable or changed. Refresh and retry; billing mode has not changed.' });
  }
  router.get('/:planId', async (req, res) => {
    try { res.json(await load(req.params.planId)); } catch (error) { failure(res, error); }
  });
  router.post('/:planId/decisions', async (req, res) => {
    const value = req.body;
    if (!value || Object.keys(value).some(key => !['expectedRevision', 'side', 'conflictIds'].includes(key))
      || !Number.isSafeInteger(value.expectedRevision) || value.expectedRevision < 0
      || !['local', 'cloud'].includes(value.side) || !Array.isArray(value.conflictIds)
      || !value.conflictIds.length || value.conflictIds.length > 5000
      || value.conflictIds.some(id => typeof id !== 'string' || !/^[a-f0-9]{64}$/.test(id))
      || typeof req.user.username !== 'string' || !req.user.username.trim()) {
      return res.status(400).json({ error: 'Provide a revision, local/cloud choice and conflict references.' });
    }
    try {
      await load(req.params.planId);
      await store.select(req.params.planId, { ...value, actor: req.user.username }, () => executor ? executor.assertMutable(req.params.planId) : Promise.resolve());
      const result = await load(req.params.planId);
      res.json(result);
    } catch (error) { failure(res, error); }
  });
  router.post('/:planId/apply', async (req, res) => {
    if (!executor) return res.status(409).json({ error: 'Conflict execution is not configured.' });
    const body = req.body;
    if (!body || Object.keys(body).some(key => !['expectedRevision','expectedHeadHash','confirmation'].includes(key)) || body.confirmation !== 'APPLY REVIEWED PRODUCT CHOICES') return res.status(400).json({ error: 'Confirm application of the saved product choices.' });
    try {
      await executor.apply(req.params.planId, { expectedRevision:body.expectedRevision, expectedHeadHash:body.expectedHeadHash, actor:req.user.username });
      res.json(await load(req.params.planId));
    } catch (error) { failure(res, error); }
  });
  return router;
}
module.exports = { createRouter };
