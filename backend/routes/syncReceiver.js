const express=require('express');
const crypto=require('node:crypto');
// A dedicated per-installation credential selects a fixed receiver identity.
// Do not share POS JWT credentials or infer the shop from the request body.
function createRouter({token,receive,mayReceive=async()=>false}){
  if(typeof token!=='string' || !/^[a-f0-9]{64,128}$/.test(token))throw Error('Dedicated sync token required.');
  const expected=crypto.createHash('sha256').update(token).digest();
  const router=express.Router();
  router.use((req,res,next)=>{
    res.setHeader('Cache-Control','no-store');
    const header=req.headers.authorization || '';
    const provided=header.startsWith('Bearer ')?header.slice(7):'';
    const valid=crypto.timingSafeEqual(expected,crypto.createHash('sha256').update(provided).digest());
    if(!valid)return res.status(401).json({error:'Sync authentication required.'});next();
  });
  router.use(express.json({limit:'1mb',strict:true}));
  router.post('/',async(req,res)=>{
    try{
      if(await mayReceive()!==true)return res.status(409).json({error:'Receiving changes is currently blocked.'});
      const result=await receive(req.body);
      res.json({eventId:result.eventId,committed:result.committed===true,duplicate:result.duplicate===true});
    }catch{res.status(409).json({error:'Event not acknowledged. Preserve it for retry or review.'});}
  });
  router.use((error,_req,res,_next)=>res.status(error.type==='entity.too.large'?413:400).json({error:'Invalid sync request.'}));
  return router;
}
module.exports={createRouter};
