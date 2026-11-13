'use strict';
const fs=require('node:fs/promises'),path=require('node:path');
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
function readinessUrl(value){const url=new URL(value);if(url.protocol!=='http:'||!['127.0.0.1','[::1]'].includes(url.hostname)||url.username||url.password||url.pathname!=='/api/ready'||url.search||url.hash)throw Error('Use a pinned loopback readiness endpoint through the verified tunnel.');return url;}
function validateAuthorityConfig(config){
  if(!path.isAbsolute(config.localBindingPath||'')||!path.isAbsolute(config.controlDirectory||'')||
    !UUID.test(config.sourceActivationId||'')||!UUID.test(config.cloudActivationId||'')||
    !Number.isSafeInteger(config.sourceGeneration)||config.sourceGeneration<0||!Number.isSafeInteger(config.cloudGeneration)||config.cloudGeneration<0||
    !Number.isInteger(config.sourceDatabasePort)||config.sourceDatabasePort<1||config.sourceDatabasePort>65535||!Number.isInteger(config.cloudDatabasePort)||config.cloudDatabasePort<1||config.cloudDatabasePort>65535)
    throw Error('Pin local and cloud authority generations before configuring daily sync.');
  readinessUrl(config.localReadyUrl);readinessUrl(config.cloudReadyUrl);return config;
}
async function verifyNativeAuthority({config,readFile=fs.readFile,lstat=fs.lstat,fetchReady=fetch}){
  validateAuthorityConfig(config);
  try{
    try{await lstat(path.join(config.controlDirectory,'native-invalidation.json'));return false;}catch(error){if(error.code!=='ENOENT')return false;}
    const local=JSON.parse(await readFile(config.localBindingPath,'utf8'));
    if(local.schemaVersion!==1||local.shopId!==config.shopId||local.activationId!==config.sourceActivationId||local.generation!==config.sourceGeneration||
      local.phase!=='active'||local.billingMode!=='active'||local.database?.database!==config.database||(local.database?.port||3306)!==config.sourceDatabasePort||local.nativeReplicationInvalidated===true)return false;
    async function ready(url){const response=await fetchReady(readinessUrl(url),{redirect:'error',signal:AbortSignal.timeout(3000)});if(!response.ok)return null;const raw=await response.text();if(raw.length>65536)return null;return JSON.parse(raw);}
    const [source,cloud]=await Promise.all([ready(config.localReadyUrl),ready(config.cloudReadyUrl)]);
    const valid=(value,role,activation,generation,mode,port)=>value?.ok===true&&value.shopId===config.shopId&&value.nodeRole===role&&value.sync===null&&
      value.recovery?.activationId===activation&&value.recovery?.generation===generation&&value.recovery?.phase==='active'&&
      value.recovery?.billingMode===mode&&value.recovery?.databaseName===config.database&&value.recovery?.databasePort===port&&value.recovery?.nativeReplicationInvalidated===false;
    return valid(source,'local-server',config.sourceActivationId,config.sourceGeneration,'active',config.sourceDatabasePort)&&valid(cloud,'cloud-standby',config.cloudActivationId,config.cloudGeneration,'standby',config.cloudDatabasePort);
  }catch{return false;}
}
module.exports={readinessUrl,validateAuthorityConfig,verifyNativeAuthority};
