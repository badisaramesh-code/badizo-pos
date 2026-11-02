const fs=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto'),{execFileSync}=require('node:child_process');
const {safeFile,verifyRelease}=require('../../backend/services/windowsReleaseUpgrade');
async function main(){
  const [commit,output]=process.argv.slice(2),root=process.cwd();
  if(process.platform!=='win32'||process.arch!=='x64'||Number(process.versions.node.split('.')[0])!==24)throw Error('Build this Windows x64 release using Node 24.');
  const git=args=>execFileSync('git',args,{cwd:root,encoding:'utf8',windowsHide:true});
  if(!/^[a-f0-9]{40}$/.test(commit||'')||git(['rev-parse','HEAD']).trim()!==commit||git(['status','--porcelain','--untracked-files=normal']).trim())throw Error('Use a clean checkout of the exact release commit.');
  if(!path.isAbsolute(output||''))throw Error('Absolute output directory required.');
  await fs.mkdir(output);
  const tracked=git(['ls-tree','-r','--name-only',commit,'--','backend','database/migrations','tools/fleet','scripts/windows/upgrade-enrolled-pos.bat','package.json']).trim().split('\n').filter(safeFile);
  for(const name of tracked){const target=path.join(output,...name.split('/'));await fs.mkdir(path.dirname(target),{recursive:true});await fs.writeFile(target,execFileSync('git',['show',commit+':'+name],{cwd:root,windowsHide:true,maxBuffer:32*1024*1024}),{flag:'wx'});}
  async function dependencies(folder,prefix){for(const entry of await fs.readdir(folder,{withFileTypes:true})){
    const name=prefix+'/'+entry.name;if(entry.isSymbolicLink())throw Error('Dependency links cannot be packaged.');
    if(!safeFile(name))continue;
    const target=path.join(output,...name.split('/'));
    if(entry.isDirectory()){await fs.mkdir(target,{recursive:true});await dependencies(path.join(folder,entry.name),name);}else if(entry.isFile()){await fs.copyFile(path.join(folder,entry.name),target);}
  }}
  await fs.mkdir(path.join(output,'backend/node_modules'),{recursive:true});await dependencies(path.join(root,'backend/node_modules'),'backend/node_modules');
  execFileSync(process.execPath,[path.join(root,'frontend/node_modules/react-scripts/bin/react-scripts.js'),'build'],{cwd:path.join(root,'frontend'),stdio:'inherit',windowsHide:true,env:{...process.env,BUILD_PATH:path.join(output,'frontend/build'),GENERATE_SOURCEMAP:'false',REACT_APP_RECOVERY_CONTROL_ENABLED:'true',REACT_APP_RECOVERY_REVIEW_ENABLED:'true',REACT_APP_STAGED_RESTORE_ENABLED:'true',REACT_APP_CHECKOUT_RECOVERY_ENABLED:'true'}});
  const files=[];async function inventory(folder,prefix=''){for(const entry of await fs.readdir(folder,{withFileTypes:true})){const name=prefix+entry.name;if(entry.isDirectory())await inventory(path.join(folder,entry.name),name+'/');else{if(!safeFile(name))throw Error('Forbidden release artifact: '+name);files.push({path:name,sha256:crypto.createHash('sha256').update(await fs.readFile(path.join(folder,entry.name))).digest('hex')});}}}
  await inventory(output);files.sort((a,b)=>a.path.localeCompare(b.path));
  const manifest={schemaVersion:1,platform:'win32',arch:'x64',nodeMajor:24,mysqlSeries:'8.0',commit,files};
  await fs.writeFile(path.join(output,'windows-release.json'),JSON.stringify(manifest,null,2),{flag:'wx'});await verifyRelease(output);
  console.log(JSON.stringify({commit,output,files:files.length,syncEnabled:false}));
}
main().catch(error=>{console.error(error.message);process.exitCode=1;});
