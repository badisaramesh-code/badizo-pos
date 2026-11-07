// Scheduled task/service launcher configured once during shop onboarding.
const fs=require('node:fs'),path=require('node:path'),{spawn}=require('node:child_process');
try{
  const config=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));
  if(!path.isAbsolute(config.root||'')||!path.isAbsolute(config.environmentFile||'')||!path.isAbsolute(config.bindingPath||'')||!path.isAbsolute(config.manualBackupDirectory||'')||!config.shopId)throw Error('Protected launcher configuration and existing manual-backup directory required.');
  const pointer=JSON.parse(fs.readFileSync(path.join(config.root,'current-release.json'),'utf8'));
  if(pointer.directory!==path.join(config.root,'releases',pointer.commit)||!/^[a-f0-9]{40}$/.test(pointer.commit))throw Error('Invalid installed release pointer.');
  const child=spawn(process.execPath,['--env-file='+config.environmentFile,'server.js'],{cwd:path.join(pointer.directory,'backend'),windowsHide:true,stdio:'inherit',env:{...process.env,BACKUP_DIR:config.manualBackupDirectory,BADIZO_RUNTIME_BINDING:config.bindingPath,BADIZO_SHOP_ID:config.shopId,BADIZO_RELEASE_COMMIT:pointer.commit,BADIZO_DB_BOOTSTRAP:'false'}});
  child.on('error',()=>{process.exitCode=1;});child.on('exit',code=>{process.exitCode=code??1;});
  process.on('SIGTERM',()=>child.kill('SIGTERM'));process.on('SIGINT',()=>child.kill('SIGTERM'));
}catch(error){console.error(error.message);process.exitCode=1;}
