const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
const {releaseBuildEnvironment}=require('../services/releaseBuildEnvironment');
test('release bundle cannot inherit developer public credentials or shop routing',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'badizo-build-env-'));
  try{
    const env=await releaseBuildEnvironment(root,'release/build',{PATH:'runtime',REACT_APP_API_URL:'http://private-shop',react_app_secret:'private',PUBLIC_URL:'http://developer',NODE_ENV:'development'});
    assert.equal(env.REACT_APP_API_URL,undefined);assert.equal(env.react_app_secret,undefined);assert.equal(env.PUBLIC_URL,'');assert.equal(env.NODE_ENV,'production');assert.equal(env.PATH,'runtime');
    for(const file of ['.env','.env.local','.env.production','.env.production.local']){
      await fs.writeFile(path.join(root,file),'REACT_APP_SECRET=private');
      await assert.rejects(releaseBuildEnvironment(root,'release/build'),/refuses frontend environment file/);
      await fs.unlink(path.join(root,file));
    }
  }finally{await fs.rm(root,{recursive:true,force:true});}
});
