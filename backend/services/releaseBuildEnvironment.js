const fs=require('node:fs/promises'),path=require('node:path');
async function releaseBuildEnvironment(frontendDirectory,output,environment=process.env){
  // CRA embeds REACT_APP_* values into public JavaScript, including values
  // from ignored developer .env files. Never ship a developer's shop address
  // or credentials merely because they were present on the build laptop.
  for(const name of ['.env','.env.local','.env.production','.env.production.local']){
    try{await fs.access(path.join(frontendDirectory,name));}
    catch(error){if(error.code==='ENOENT')continue;throw error;}
    throw Error('Release build refuses frontend environment file: '+name);
  }
  const env=Object.fromEntries(Object.entries(environment).filter(([key])=>!/^REACT_APP_/i.test(key)&&!['NODE_ENV','PUBLIC_URL','BUILD_PATH','GENERATE_SOURCEMAP'].includes(key.toUpperCase())));
  return {...env,NODE_ENV:'production',PUBLIC_URL:'',BUILD_PATH:output,GENERATE_SOURCEMAP:'false',REACT_APP_RECOVERY_CONTROL_ENABLED:'true',REACT_APP_RECOVERY_REVIEW_ENABLED:'true',REACT_APP_STAGED_RESTORE_ENABLED:'true',REACT_APP_CHECKOUT_RECOVERY_ENABLED:'true'};
}
module.exports={releaseBuildEnvironment};
