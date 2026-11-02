const express=require('express');
const {peerAuthentication}=require('./syncReceiver');
function createRouter({token,feed,mayShare=async()=>false}){
  const router=express.Router();router.use(peerAuthentication(token));
  router.use(express.json({limit:'2kb',strict:true}));
  router.get('/pending',async(_req,res)=>{
    try{if(await mayShare()!==true)return res.status(409).json({error:'Cloud updates are currently unavailable.'});res.json(await feed.pending());}
    catch{res.status(409).json({error:'Unable to read pending updates.'});}
  });
  router.post('/ack',async(req,res)=>{
    try{if(await mayShare()!==true)return res.status(409).json({error:'Acknowledgment is currently blocked.'});res.json(await feed.acknowledge(req.body));}
    catch{res.status(409).json({error:'Update was not acknowledged. Retain it for retry.'});}
  });
  router.use((error,_req,res,_next)=>res.status(error.type==='entity.too.large'?413:400).json({error:'Invalid sync request.'}));
  return router;
}
module.exports={createRouter};
