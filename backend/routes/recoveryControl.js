const express=require('express');
const {authenticate,authorize}=require('../middleware/auth');
function createRouter(control){
  const router=express.Router();router.use(authenticate,authorize('SERVER'));
  router.use((_req,res,next)=>{res.setHeader('Cache-Control','no-store');next();});
  router.get('/',async(_req,res)=>{try{res.json(await control.status());}catch{res.status(409).json({error:'Recovery control state requires inspection.'});}});
  router.post('/',async(req,res)=>{
    const value=req.body,phrases={'activate-restore':'USE VERIFIED RESTORE','standby':'PAUSE BILLING','emergency-local':'START LOCAL AND RECONCILE LATER','emergency-cloud':'LOCAL BILLING IS STOPPED - USE CLOUD','use-cloud':'SYNC AND USE CLOUD','use-local':'SYNC AND USE LOCAL'};
    if(!value||Object.keys(value).some(key=>!['kind','jobId','expectedGeneration','confirmation'].includes(key))||!Object.hasOwn(phrases,value.kind)||value.confirmation!==phrases[value.kind])return res.status(400).json({error:'Confirm the selected recovery action.'});
    try{res.status(202).json(await control.request({...value,actor:req.user.username}));}catch{res.status(409).json({error:'Recovery could not start. Refresh the status; no completed switch is confirmed.'});}
  });return router;
}
module.exports={createRouter};
