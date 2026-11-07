// Prepares disabled fresh enrollment on two detached verified snapshot clones.
// It does not activate either database, switch a service, or replace originals.
const fs=require('node:fs/promises'),path=require('node:path'),mysql=require('mysql2/promise');
const {prepareSameSnapshotEnrollment}=require('../../backend/services/recoveryBaselineEnrollment');
async function main(){
  const file=process.argv[2];if(!path.isAbsolute(file||''))throw Error('Absolute protected copy-enrollment configuration required.');
  const c=JSON.parse(await fs.readFile(file,'utf8'));if(c.schemaVersion!==1||!Array.isArray(c.sides)||c.sides.length!==2)throw Error('Invalid copy-enrollment configuration.');
  const credentials=[];
  for(const side of c.sides){
    if(!path.isAbsolute(side.credentialsFile||''))throw Error('Protected candidate credentials required.');
    const db=JSON.parse(await fs.readFile(side.credentialsFile,'utf8'));
    if(db.database!==side.databaseName||!['localhost','127.0.0.1','::1'].includes(db.host)||typeof db.user!=='string'||typeof db.password!=='string')throw Error('Candidate credentials differ.');
    credentials.push({host:db.host,user:db.user,password:db.password,database:db.database,supportBigNumbers:true,bigNumberStrings:true,connectionLimit:3});
  }
  const pools=credentials.map(db=>mysql.createPool(db));
  try{
    const report=await prepareSameSnapshotEnrollment({pools,configuration:c,reportPath:c.reportPath});
    console.log(JSON.stringify({state:report.state,baselineId:report.baselineId,readyForProtectedEnrollment:report.readyForProtectedEnrollment,syncEnabled:false,activated:false,reportPath:c.reportPath}));
  }finally{await Promise.all(pools.map(pool=>pool.end()));}
}
main().catch(()=>{console.error('Copy enrollment preparation stopped. Candidate databases and original evidence are retained; no live activation was performed.');process.exitCode=1;});
