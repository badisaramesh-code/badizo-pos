'use strict';
const fs=require('node:fs');
function matchesBackupAuthority(file,binding){
 if(!binding.bound)return true;
 try{const stat=fs.lstatSync(file+'.authority.json');if(!stat.isFile()||stat.isSymbolicLink())return false;const a=JSON.parse(fs.readFileSync(file+'.authority.json','utf8'));return a.schemaVersion===1&&a.activationId===binding.activationId&&a.databaseName===binding.databaseName;}catch{return false;}
}
function recordBackupAuthority(file,binding){if(!binding.bound)return;binding.assertUnchanged();fs.writeFileSync(file+'.authority.json',JSON.stringify({schemaVersion:1,activationId:binding.activationId,databaseName:binding.databaseName,createdAt:new Date().toISOString()}),{flag:'wx',mode:0o600});binding.assertUnchanged();}
module.exports={matchesBackupAuthority,recordBackupAuthority};
