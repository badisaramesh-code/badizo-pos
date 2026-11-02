const fs=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto'),{spawn,execFile}=require('node:child_process'),{promisify}=require('node:util'),{pipeline}=require('node:stream/promises');
const {verifyRelease,stageRelease,applyWindowsRelease,recoverWindowsRelease}=require('../../backend/services/windowsReleaseUpgrade');
const {installSyncSchema}=require('../../backend/services/syncSchemaInstaller');
const {json}=require('../../backend/services/recoveryControlFiles');
const mysql=require('../../backend/node_modules/mysql2/promise');
async function main(){
  const [configFile,mode,source]=process.argv.slice(2);
  if(process.platform!=='win32'||Number(process.versions.node.split('.')[0])!==24||!path.isAbsolute(configFile||'')||!['--plan','--apply','--recover'].includes(mode))throw Error('Use Windows Node 24: upgrade-windows-release.cjs PRIVATE_CONFIG --plan|--apply RELEASE_DIRECTORY (or --recover).');
  const config=await json(configFile);
  for(const key of ['root','bindingPath','dbConfigPath','dumpExecutable','dumpDefaultsFile'])if(!path.isAbsolute(config[key]||''))throw Error('Protected absolute upgrade configuration required.');
  if(!/^[A-Z][A-Z0-9_-]{2,31}$/.test(config.shopId||''))throw Error('Shop identity required.');
  const readyUrl=new URL(config.readyUrl);if(readyUrl.protocol!=='http:'||!['127.0.0.1','localhost'].includes(readyUrl.hostname)||readyUrl.pathname!=='/api/ready')throw Error('Use a local readiness endpoint.');
  async function command(name){const c=config[name];if(!path.isAbsolute(c?.file||'')||!Array.isArray(c.args)||c.args.some(arg=>typeof arg!=='string'))throw Error('Fixed service command required: '+name);await promisify(execFile)(c.file,c.args,{windowsHide:true,timeout:60000});}
  async function waitReady(activationId,commit){
    const end=Date.now()+45000;while(Date.now()<end){try{const response=await fetch(readyUrl,{redirect:'error',signal:AbortSignal.timeout(2000)});const state=await response.json();if(response.ok&&state.ok&&state.shopId===config.shopId&&state.recovery?.activationId===activationId&&state.recovery.phase==='validating'&&(commit?state.releaseCommit===commit:state.recovery.activeWrites===0))return;}catch{}await new Promise(resolve=>setTimeout(resolve,250));}throw Error('Release readiness or write drain timed out.');
  }
  const credentials=await json(config.dbConfigPath),binding=await json(config.bindingPath);
  if(credentials.database!==binding.database.database||!['localhost','127.0.0.1','::1'].includes(credentials.host))throw Error('Upgrade database differs from the local binding.');
  const connection=await mysql.createConnection({host:credentials.host,user:credentials.user,password:credentials.password,database:credentials.database});
  const adapters={stop:()=>command('stop'),start:()=>command('start'),drain:id=>waitReady(id),ready:(commit,id)=>waitReady(id,commit),installSchema:(release,database)=>installSyncSchema({connection,directory:path.join(release,'database/migrations'),expectedDatabase:database,apply:true}),backup:async()=>{
    const folder=path.join(config.root,'upgrade-backups');await fs.mkdir(folder,{recursive:true});const target=path.join(folder,crypto.randomUUID()+'.sql');
    const child=spawn(config.dumpExecutable,['--defaults-extra-file='+config.dumpDefaultsFile,'--single-transaction','--routines','--triggers','--events','--hex-blob',credentials.database],{windowsHide:true,stdio:['ignore','pipe','ignore']});
    const done=new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',code=>code===0?resolve():reject(Error('Database backup failed.')));});
    try{await Promise.all([done,pipeline(child.stdout,require('node:fs').createWriteStream(target,{flags:'wx',mode:0o600}))]);}catch(error){child.kill();throw error;}
    const data=await fs.readFile(target);if(!data.length||!data.toString('utf8',Math.max(0,data.length-2048)).includes('Dump completed'))throw Error('Database backup is incomplete.');
    return {path:target,sha256:crypto.createHash('sha256').update(data).digest('hex')};
  }};
  try{
    if(mode==='--plan'){const manifest=await verifyRelease(source);const plan=await installSyncSchema({connection,directory:path.join(source,'database/migrations'),expectedDatabase:credentials.database});console.log(JSON.stringify({commit:manifest.commit,schema:plan,applicationChanged:false}));return;}
    const staged=mode==='--apply'?await stageRelease(source,config.root):null;
    await command('stopSupervisor');
    try{const result=mode==='--recover'?await recoverWindowsRelease({...config,adapters}):await applyWindowsRelease({...config,release:staged.directory,adapters});await command('startSupervisor');console.log(JSON.stringify(result));}
    catch(error){const latest=await json(config.bindingPath);if(latest.phase==='active')await command('startSupervisor');throw error;}
  }finally{await connection.end();}
}
main().catch(error=>{console.error(error.message);process.exitCode=1;});
