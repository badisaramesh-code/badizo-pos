const express = require('express');
const {authenticate,authorize} = require('../middleware/auth');
const router = express.Router();
router.use(authenticate,authorize('ADMIN','SERVER'));
async function remote(operation,body) {
  const token=process.env.BADIZO_MAINTENANCE_TOKEN;
  const origin=new URL(process.env.BADIZO_MANAGEMENT_ORIGIN);
  if (!/^[a-f0-9]{64}$/.test(token||'') || origin.protocol!=='https:' || origin.username || origin.password || origin.pathname!=='/' || origin.search || origin.hash) throw Error('Invalid management configuration.');
  const response=await fetch(new URL('/api/agent/maintenance/'+operation,origin),{method:'POST',redirect:'error',
    signal:AbortSignal.timeout(5000),headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify(body)});
  const data=await response.json();
  return {status:response.status,data};
}
router.get('/',async(_req,res)=>{
  if (!process.env.BADIZO_MAINTENANCE_TOKEN || !process.env.BADIZO_MANAGEMENT_ORIGIN) return res.json({configured:false});
  try {const result=await remote('status',{});res.status(result.status).json({...result.data,configured:true,runningCommit:process.env.BADIZO_RELEASE_COMMIT || null});}
  catch {res.status(503).json({error:'Unable to reach shop management.'});}
});
router.post('/',async(req,res)=>{
  if(!['update','restart','repair'].includes(req.body?.action))return res.status(400).json({error:'Invalid maintenance action.'});
  try{const result=await remote('request',{action:req.body.action,target:req.body.target});res.status(result.status).json(result.data);}
  catch {res.status(503).json({error:'Unable to reach shop management.'});}
});
module.exports=router;
