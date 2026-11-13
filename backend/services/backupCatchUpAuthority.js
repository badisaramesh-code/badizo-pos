'use strict';
const {matchesBackupAuthority}=require('../scripts/backupArtifactAuthority');
function matchesCurrentBackupAuthority(file,env=process.env){
 if(!env.BADIZO_RUNTIME_BINDING)return true;
 try{const binding=require('./recoveryRuntimeBinding').read(env);if(binding.phase!=='active'||binding.billingMode!=='active')return false;return matchesBackupAuthority(file,{bound:true,activationId:binding.activationId,databaseName:binding.database.database});}catch{return false;}
}
module.exports={matchesCurrentBackupAuthority};
