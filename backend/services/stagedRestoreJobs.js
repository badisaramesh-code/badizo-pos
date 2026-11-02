const fs=require('node:fs/promises');
const path=require('node:path');
const crypto=require('node:crypto');
const {spawn}=require('node:child_process');
function createStagedRestoreJobs({directory,shopId,configPath,python='python',scriptPath=path.resolve(__dirname,'../../tools/fleet/restore-staged.py'),run}) {
  if(!path.isAbsolute(directory || '') || !path.isAbsolute(configPath || '') || !/^[A-Z][A-Z0-9_-]{2,31}$/.test(shopId || ''))throw Error('Explicit protected restore configuration required.');
  const lock=path.join(directory,'active.lock');
  function filename(id) {if(!/^[a-f0-9-]{36}$/.test(id || ''))throw Error('Invalid restore job.');return path.join(directory,id+'.json');}
  async function write(job) {
    const file=filename(job.id),temporary=file+'.'+crypto.randomUUID()+'.tmp';
    const handle=await fs.open(temporary,'wx',0o600);
    try{await handle.writeFile(JSON.stringify(job));await handle.sync();}finally{await handle.close();}
    // Windows can briefly deny replacement while a status reader or scanner
    // holds the destination. Retry the atomic rename; never delete the prior
    // durable status as a workaround.
    for(let attempt=0;;attempt++){
      try{await fs.rename(temporary,file);break;}
      catch(error){
        if(!['EPERM','EACCES','EBUSY'].includes(error.code) || attempt>=20)throw error;
        await new Promise(resolve=>setTimeout(resolve,25*(attempt+1)));
      }
    }
  }
  async function read(id) {
    const job=JSON.parse(await fs.readFile(filename(id),'utf8'));
    if(job.shopId!==shopId)throw Error('Shop mismatch.');return job;
  }
  const execute=run || (()=>new Promise((resolve,reject)=>{
    const child=spawn(python,[scriptPath,configPath],{windowsHide:true,shell:false,stdio:['ignore','pipe','ignore']});
    let output='',overflow=false;
    child.stdout.on('data',data=>{if(output.length+data.length>65536)overflow=true;else output+=data.toString();});
    child.on('error',()=>reject(Error('Restore process could not start.')));
    child.on('close',code=>{
      if(code!==0 || overflow)return reject(Error('Restore failed. Recovery target may contain partial data.'));
      try{resolve(JSON.parse(output));}catch{reject(Error('Invalid restore result.'));}
    });
  }));
  async function start(actor) {
    if(typeof actor!=='string' || !actor.trim())throw Error('Signed-in owner required.');
    const config=JSON.parse(await fs.readFile(configPath,'utf8'));
    if(config.shopId!==shopId)throw Error('Configured backup belongs to another shop.');
    await fs.mkdir(directory,{recursive:true,mode:0o700});
    const id=crypto.randomUUID();
    const guard=await fs.open(lock,'wx',0o600);await guard.writeFile(id);await guard.sync();await guard.close();
    const job={id,shopId,actor,state:'running',startedAt:new Date().toISOString(),activated:false};
    try{await write(job);}catch(error){await fs.unlink(lock);throw error;}
    // Persist completion before releasing the lock. If this process stops,
    // leave the lock for operator inspection; never automatically repeat SQL.
    (async()=>{
      let terminal;
      try {
        const result=await execute();
        if(result.shopId!==shopId || result.database!==config.database || result.stagedRestoreVerified!==true || result.activated!==false
          || !['products','invoices','tableCount'].every(key=>Number.isSafeInteger(result[key]) && result[key]>=0))throw Error('Unverified restore result.');
        terminal={...job,state:'verified',finishedAt:new Date().toISOString(),result:{database:result.database,tableCount:result.tableCount,products:result.products,invoices:result.invoices,activated:false}};
      }catch{terminal={...job,state:'failed',finishedAt:new Date().toISOString(),message:'Restore did not verify. Preserve the recovery database for inspection; active billing was not switched.'};}
      await write(terminal);
      if(terminal.state==='verified')await fs.unlink(lock);
      // Failed/ambiguous jobs keep the lock. Provision a fresh empty target
      // and inspect existing workers before an operator clears it.
    })().catch(()=>{});
    return job;
  }
  async function status() {
    let active;
    try{active=(await fs.readFile(lock,'utf8')).trim();}catch(error){if(error.code!=='ENOENT')throw error;}
    if(active)return {configured:true,job:await read(active)};
    let files;try{files=await fs.readdir(directory);}catch(error){if(error.code==='ENOENT')return {configured:true,job:null};throw error;}
    const jobs=await Promise.all(files.filter(name=>/^[a-f0-9-]{36}\.json$/.test(name)).map(name=>read(name.slice(0,-5))));
    jobs.sort((a,b)=>b.startedAt.localeCompare(a.startedAt));
    return {configured:true,job:jobs[0] || null};
  }
  return {start,read,status};
}
module.exports={createStagedRestoreJobs};
