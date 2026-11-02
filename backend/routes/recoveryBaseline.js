const express=require('express'),crypto=require('node:crypto');
const {json}=require('../services/recoveryControlFiles');
const {loadPlan,nodeStatus}=require('../services/recoveryBaselineActivation');
function createRouter({configPath,control,runtimeStatus}){
  const router=express.Router();
  router.use(async(req,res,next)=>{
    res.setHeader('Cache-Control','no-store');
    try{
      const config=await json(configPath),{plan}=await loadPlan(config);
      const supplied=String(req.headers.authorization||'');
      const expected='Bearer '+plan.incomingToken;
      if(config.nodeRole==='local-server'||Buffer.byteLength(supplied)!==Buffer.byteLength(expected)||!crypto.timingSafeEqual(Buffer.from(supplied),Buffer.from(expected)))return res.status(401).json({error:'Recovery authentication required.'});
      req.recoveryConfig=config;req.recoveryPlan=plan;next();
    }catch{res.status(409).json({error:'Prepared recovery is unavailable.'});}
  });
  router.get('/',async(req,res)=>{try{
    const state=await nodeStatus(req.recoveryConfig),runtime=await runtimeStatus?.(),binding=require('../services/recoveryRuntimeBinding').status();
    const {report}=await loadPlan(req.recoveryConfig);
    const operation=(await control.status()).operation;
    res.json({...state,operation:operation?{kind:operation.kind,state:operation.state,message:operation.message}:null,activeWrites:binding?.activeWrites??-1,runtimeReady:binding?.activationId===state.candidateActivationId&&runtime?.ready===true&&runtime.shopId===state.shopId&&runtime.baselineId===state.baselineId&&runtime.installationId===report.installationIds[1]&&runtime.peerInstallationId===report.installationIds[0]});
  }catch{res.status(409).json({error:'Recovery status unavailable.'});}});
  router.post('/',express.json({limit:'2kb'}),async(req,res)=>{
    try{
      const body=req.body;if(!body||Object.keys(body).sort().join(',')!=='action,operationId'||body.operationId!==req.recoveryPlan.operationId||!['stage','release'].includes(body.action))throw Error('Invalid recovery operation.');
      const state=await control.status();
      // A lost acknowledgement may retry while the same supervisor task is
      // already queued. Do not create another concurrent operation.
      const kind=body.action==='stage'?'baseline-stage':'baseline-release';
      if(state.operation?.kind===kind&&state.operation.handoffId===body.operationId&&!['complete','failed','rolled-back'].includes(state.operation.state))return res.status(202).json({state:'pending'});
      res.status(202).json(await control.request({kind,handoffId:body.operationId,expectedGeneration:state.generation,actor:'prepared-recovery-peer'}));
    }catch{res.status(409).json({error:'Recovery step not accepted. Refresh status before retrying.'});}
  });
  return router;
}
module.exports={createRouter};
