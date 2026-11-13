const fs=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto');
function sharedStateFile(file,c){
  if(!c||!Number.isSafeInteger(c.gid)||c.gid<0||!['bindingPath','directory','uploadDirectory'].every(key=>path.isAbsolute(c[key]||'')))throw Error('Invalid shared recovery state policy.');
  const target=path.resolve(file);
  if(target===path.resolve(c.bindingPath)||['heartbeat.json','operation.json'].some(name=>target===path.join(path.resolve(c.directory),name))||target===path.join(path.resolve(c.uploadDirectory),'activation-history.json'))return true;
  const relative=path.relative(path.resolve(c.uploadDirectory),target).split(path.sep);
  return relative.length===2&&/^[a-f0-9-]{36}$/.test(relative[0])&&relative[1]==='upload.json';
}
async function sharedPolicy(file){
  const configured=process.env.BADIZO_RECOVERY_SHARED_STATE_CONFIG;
  if(!configured||typeof process.getuid!=='function'||process.getuid()!==0)return null;
  if(!path.isAbsolute(configured))throw Error('Shared recovery policy must use a protected absolute file.');
  const stat=await fs.lstat(configured);
  if(!stat.isFile()||stat.isSymbolicLink()||stat.uid!==0||(stat.mode&0o022))throw Error('Shared recovery policy must be root-owned and not writable by others.');
  const policy=JSON.parse(await fs.readFile(configured,'utf8'));
  return sharedStateFile(file,policy)?policy:null;
}
async function shareStateHandle(file,handle){const policy=await sharedPolicy(file);if(policy){await handle.chown(0,policy.gid);await handle.chmod(0o640);}}
async function atomic(file,value){
  const policy=await sharedPolicy(file);
  await fs.mkdir(path.dirname(file),{recursive:true,mode:0o700});
  const temporary=file+'.'+crypto.randomUUID()+'.tmp';
  const handle=await fs.open(temporary,'wx',0o600);
  try{await handle.writeFile(JSON.stringify(value));if(policy){await handle.chown(0,policy.gid);await handle.chmod(0o640);}await handle.sync();}finally{await handle.close();}
  try{
    for(let attempt=0;;attempt++){
      try{await fs.rename(temporary,file);break;}catch(error){if(!['EPERM','EACCES','EBUSY'].includes(error.code)||attempt===20)throw error;await new Promise(resolve=>setTimeout(resolve,25*(attempt+1)));}
    }
  }finally{await fs.unlink(temporary).catch(()=>{});}
}
async function json(file){return JSON.parse(await fs.readFile(file,'utf8'));}
module.exports={atomic,json,sharedStateFile,shareStateHandle};
