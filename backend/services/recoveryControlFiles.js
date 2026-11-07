const fs=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto');
async function atomic(file,value){
  await fs.mkdir(path.dirname(file),{recursive:true,mode:0o700});
  const temporary=file+'.'+crypto.randomUUID()+'.tmp';
  const handle=await fs.open(temporary,'wx',0o600);
  try{await handle.writeFile(JSON.stringify(value));await handle.sync();}finally{await handle.close();}
  try{
    for(let attempt=0;;attempt++){
      try{await fs.rename(temporary,file);break;}catch(error){if(!['EPERM','EACCES','EBUSY'].includes(error.code)||attempt===20)throw error;await new Promise(resolve=>setTimeout(resolve,25*(attempt+1)));}
    }
  }finally{await fs.unlink(temporary).catch(()=>{});}
}
async function json(file){return JSON.parse(await fs.readFile(file,'utf8'));}
module.exports={atomic,json};
