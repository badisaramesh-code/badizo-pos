// Install as a separate OS service, outside the POS service's process group.
// The protected configuration supplies fixed start/stop commands; HTTP users
// cannot submit commands, paths, credentials or database names.
const fs=require('node:fs/promises'),path=require('node:path');
const {atomic,json}=require('../../backend/services/recoveryControlFiles');
const {createRecoverySupervisor}=require('../../backend/services/recoverySupervisor');
async function main(){
  const config=await json(process.argv[2]);
  const supervisor=createRecoverySupervisor(config);
  await fs.mkdir(config.directory,{recursive:true,mode:0o700});
  const releaseLock=await require('../../backend/services/supervisorLock').acquireSupervisorLock(config.directory);
  const heartbeat=()=>atomic(path.join(config.directory,'heartbeat.json'),{shopId:config.shopId,at:new Date().toISOString()});
  await heartbeat();const timer=setInterval(()=>heartbeat().catch(()=>{}),2000);
  let stopping=false;
  process.once('SIGTERM',()=>{stopping=true;});process.once('SIGINT',()=>{stopping=true;});
  try{while(!stopping){await supervisor.tick();await new Promise(resolve=>setTimeout(resolve,1000));}}
  finally{clearInterval(timer);await releaseLock();}
}
main().catch(()=>{console.error('Recovery supervisor stopped. Inspect its protected state before restarting.');process.exitCode=1;});
