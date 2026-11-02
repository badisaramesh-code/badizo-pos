const express=require('express');
const {authenticate,authorize}=require('../middleware/auth');
function createRouter({cases,receive,canApply,pool}){
  const router=express.Router();router.use(authenticate,authorize('SERVER'));router.use((_req,res,next)=>{res.setHeader('Cache-Control','no-store');next();});
  router.get('/',async(_req,res)=>{try{res.json({cases:await cases.list()});}catch{res.status(409).json({error:'Financial cases require inspection.'});}});
  router.get('/:id',async(req,res)=>{try{res.json(await cases.inspect(req.params.id,pool));}catch{res.status(409).json({error:'Case details could not be loaded.'});}});
  router.post('/:id/retry',async(req,res)=>{
    const body=req.body;
    if(!body||Object.keys(body).some(key=>!['expectedRevision','note','confirmation'].includes(key))||body.confirmation!=='RETRY WITHOUT DISCARDING RECORDS')return res.status(400).json({error:'Describe your correction and confirm a retry.'});
    try{
      if(!await canApply())throw Error('Not enrolled');
      res.json(await cases.retry(req.params.id,{expectedRevision:body.expectedRevision,note:body.note,actor:req.user.username},receive));
    }catch{res.status(409).json({error:'Case changed or recovery is paused. Reload before retrying.'});}
  });return router;
}
module.exports={createRouter};
