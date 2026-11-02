const express=require('express');
const {authenticate,authorize}=require('../middleware/auth');
function createRouter(jobs) {
  const router=express.Router();router.use(authenticate,authorize('SERVER'));
  router.use((_req,res,next)=>{res.setHeader('Cache-Control','no-store');next();});
  router.get('/',async(_req,res)=>{try{res.json(await jobs.status());}catch{res.status(409).json({error:'Recovery requires operator inspection.'});}});
  router.get('/:id',async(req,res)=>{try{res.json(await jobs.read(req.params.id));}catch{res.status(404).json({error:'Restore job unavailable.'});}});
  router.post('/',async(req,res)=>{
    if(!req.body || Object.keys(req.body).length!==1 || req.body.confirmation!=='RESTORE TO SEPARATE DATABASE')return res.status(400).json({error:'Confirm staged restore.'});
    try{res.status(202).json(await jobs.start(req.user.username));}catch{res.status(409).json({error:'Restore unavailable, already running, or awaiting inspection. No billing switch performed.'});}
  });return router;
}
module.exports={createRouter};
