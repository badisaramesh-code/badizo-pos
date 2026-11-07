const express=require('express'),crypto=require('node:crypto'),fs=require('node:fs');
const {pipeline}=require('node:stream/promises');
const {json}=require('../services/recoveryControlFiles');
const {configuration,createRecoveryPreparation}=require('../services/recoveryPreparation');
function createRouter({configPath,control}){
  const router=express.Router();
  router.use(async(req,res,next)=>{
    res.setHeader('Cache-Control','no-store');
    try{
      const supervisor=await json(configPath),config=await configuration(supervisor),expected='Bearer '+config.incomingToken,supplied=String(req.headers.authorization||'');
      if(supervisor.nodeRole==='local-server'||Buffer.byteLength(expected)!==Buffer.byteLength(supplied)||!crypto.timingSafeEqual(Buffer.from(expected),Buffer.from(supplied)))return res.status(401).json({error:'Recovery authentication required.'});
      req.preparation=createRecoveryPreparation(supervisor);next();
    }catch{res.status(409).json({error:'Recovery preparation is not configured.'});}
  });
  router.get('/:id/artifact',async(req,res)=>{
    try{const artifact=await req.preparation.artifact(req.params.id);res.setHeader('Content-Type','application/octet-stream');res.setHeader('Content-Length',artifact.bytes);await pipeline(fs.createReadStream(artifact.file),res);}
    catch{if(!res.headersSent)res.status(409).json({error:'Verified recovery artifact unavailable.'});else res.destroy();}
  });
  router.get('/:id',async(req,res)=>{try{res.json(await req.preparation.status(req.params.id));}catch{res.status(404).json({error:'Recovery operation unavailable.'});}});
  router.post('/',express.json({limit:'2kb'}),async(req,res)=>{
    try{
      const body=req.body;if(!body||!/^[a-f0-9-]{36}$/.test(body.operationId||''))throw Error('Invalid operation.');
      if(body.action==='export'&&['verified-copy','lost-local-copy'].includes(body.mode)&&Object.keys(body).sort().join(',')==='action,mode,operationId'){
        const state=await control.status();
        if(state.operation?.kind==='prepare-export'&&!['complete','failed','rolled-back'].includes(state.operation.state)){
          if(state.operation.handoffId!==body.operationId||state.operation.mode!==body.mode)throw Error('Another operation is pending.');
          return res.status(202).json({state:'pending'});
        }
        return res.status(202).json(await control.request({kind:'prepare-export',handoffId:body.operationId,mode:body.mode,expectedGeneration:state.generation,actor:'prepared-recovery-peer'}));
      }
      if(body.action==='finalize'&&Object.keys(body).sort().join(',')==='action,localDatabase,operationId')return res.json(await req.preparation.finalize(body.operationId,body.localDatabase));
      if(body.action==='cancel'&&Object.keys(body).sort().join(',')==='action,operationId')return res.json(await req.preparation.cancelCloud(body.operationId));
      throw Error('Invalid operation.');
    }catch{res.status(409).json({error:'Preparation step not accepted. Existing data was retained.'});}
  });
  return router;
}
module.exports={createRouter};
