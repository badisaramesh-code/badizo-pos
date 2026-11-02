const express = require('express');
const { authenticate, authorize } = require('../middleware/auth');
const { createCloudSyncSettingsService } = require('../services/cloudSyncSettingsService');

function createRouter(service = createCloudSyncSettingsService()) {
  const router = express.Router();
  router.use(authenticate);
  router.get('/settings', authorize('SERVER', 'ADMIN'), async (_req, res) => {
    try { res.setHeader('Cache-Control', 'no-store'); res.json(await service.state()); }
    catch (error) { res.status(error.status || 500).json({ error: error.message || 'Unable to read cloud sync settings.' }); }
  });
  router.post('/settings', authorize('SERVER'), async (req, res) => {
    try { res.setHeader('Cache-Control', 'no-store'); res.json(await service.save(req.body, req.user)); }
    catch (error) { res.status(error.status || 500).json({ error: error.message || 'Unable to save cloud sync settings.' }); }
  });
  router.post('/run', authorize('SERVER'), async (req, res) => {
    res.setHeader('Cache-Control','no-store');
    if(req.body && Object.keys(req.body).length)return res.status(400).json({error:'This action does not accept connection settings or credentials.'});
    try { res.status(202).json(await service.requestNow(req.user)); }
    catch(error) { res.status(error.status || 500).json({error:error.status ? error.message : 'Unable to queue cloud update.'}); }
  });
  return router;
}
module.exports = createRouter();
module.exports.createRouter = createRouter;
