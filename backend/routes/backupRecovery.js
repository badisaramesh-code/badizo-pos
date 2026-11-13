'use strict';
const express = require('express');
const { authenticate, authorize } = require('../middleware/auth');
function createRouter(service) {
  const router = express.Router();
  router.use(authenticate, authorize('SERVER'));
  router.use((_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });
  router.get('/', async (_req, res) => {
    try { res.json(await service.status()); }
    catch { res.status(503).json({ error: 'Backup recovery needs installer setup or inspection.' }); }
  });
  router.post('/uploads', async (req, res) => {
    if (!/^application\/octet-stream(?:;|$)/i.test(req.headers['content-type'] || '') ||
        Object.keys(req.query).some(key => key !== 'filename')) {req.completeRecoveryWrite?.();return res.status(400).json({ error: 'Upload a SQL or SQL.GZ file as binary data.' });}
    const length = req.headers['content-length'] == null ? null : Number(req.headers['content-length']);
    try { res.status(201).json(await service.receive(req, { filename: req.query.filename, actor: req.user.username, length })); }
    catch { res.status(409).json({ error: 'Upload incomplete, too large, unavailable, or target billing is active. No database was replaced.' }); }
    finally{req.completeRecoveryWrite?.();}
  });
  router.post('/recover', async (req, res) => {
    try { res.status(202).json(await service.request(req.body, req.user.username)); }
    catch { res.status(409).json({ error: 'Recovery could not queue. Confirm the backup loss and that the other server is stopped, then refresh status.' }); }
    finally{req.completeRecoveryWrite?.();}
  });
  router.post('/discard',async(req,res)=>{
    if(!req.body||Object.keys(req.body).join(',')!=='uploadId'){req.completeRecoveryWrite?.();return res.status(400).json({error:'Select the unqueued upload.'});}
    try{res.json(await service.discard(req.body.uploadId,req.user.username));}
    catch{res.status(409).json({error:'Only an upload that has not started recovery can be set aside. Evidence is retained.'});}
    finally{req.completeRecoveryWrite?.();}
  });
  return router;
}
module.exports = { createRouter };
