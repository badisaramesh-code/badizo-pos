const express=require('express');
const {authenticate,authorize}=require('../middleware/auth');
function createRouter({cases,receive,canApply,pool,corrections=null}){
  const router=express.Router();router.use(authenticate,authorize('SERVER'));router.use((_req,res,next)=>{res.setHeader('Cache-Control','no-store');next();});
  router.get('/',async(_req,res)=>{try{res.json({cases:await cases.list()});}catch{res.status(409).json({error:'Financial cases require inspection.'});}});
  router.get('/:id',async(req,res)=>{try{res.json({...await cases.inspect(req.params.id,pool),correctionsAvailable:corrections?.enabled===true});}catch{res.status(409).json({error:'Case details could not be loaded.'});}});
  router.post('/:id/retry',async(req,res)=>{
    const body=req.body;
    if(!body||Object.keys(body).some(key=>!['expectedRevision','note','confirmation'].includes(key))||body.confirmation!=='RETRY WITHOUT DISCARDING RECORDS'){req.completeRecoveryWrite?.();return res.status(400).json({error:'Describe your correction and confirm a retry.'});}
    try{
      if(!await canApply())throw Error('Not enrolled');
      res.json(await cases.retry(req.params.id,{expectedRevision:body.expectedRevision,note:body.note,actor:req.user.username},receive));
    }catch{res.status(409).json({error:'Case changed or recovery is paused. Reload before retrying.'});}finally{req.completeRecoveryWrite?.();}
  });
  for(const [path,method,field,confirmation,action] of [
    ['match-payment','matchPayment','targetPaymentId','THESE ARE THE SAME PHYSICAL PAYMENT','match-supplier-payment'],
    ['accept-stock-delta','acceptStockDelta','expectedStock','APPLY THE VERIFIED STOCK DIFFERENCE','accept-stock-delta']
  ])router.post('/:id/'+path,async(req,res)=>{
    const body=req.body;
    const allowed=['expectedRevision','note','confirmation',field,...(method==='acceptStockDelta'?['expectedLocalAuditIds']:[])];
    if(!body||Object.keys(body).some(key=>!allowed.includes(key))||body.confirmation!==confirmation||typeof body.note!=='string'||body.note.trim().length<10){req.completeRecoveryWrite?.();return res.status(400).json({error:'Verify the proposed correction and provide a detailed note.'});}
    try{
      if(!corrections?.enabled||!await canApply())throw Error('Local corrections unavailable');
      const options={expectedRevision:body.expectedRevision,note:body.note,actor:req.user.username,[field]:body[field],...(method==='acceptStockDelta'?{expectedLocalAuditIds:body.expectedLocalAuditIds}:{})};
      res.json(await cases.retry(req.params.id,{...options,action},event=>corrections[method](event,options)));
    }catch{res.status(409).json({error:'Correction was not confirmed. Reload the case and verify the current records; no automatic overwrite is permitted.'});}finally{req.completeRecoveryWrite?.();}
  });return router;
}
module.exports={createRouter};
