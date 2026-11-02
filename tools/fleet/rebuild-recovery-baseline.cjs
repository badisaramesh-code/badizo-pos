// Technician tool for detached staging copies. Never imports the POS server,
// changes a live binding, enables enrollment or acknowledges original queues.
const fs=require('node:fs/promises'),path=require('node:path'),mysql=require('mysql2/promise');
const {rebuildBaseline,allowedDatabase}=require('../../backend/services/recoveryBaselineRebuild');
async function main(){
  const [file,mode]=process.argv.slice(2);
  if(!path.isAbsolute(file||'')||!['--plan','--apply'].includes(mode))throw Error('Usage: rebuild-recovery-baseline.cjs ABSOLUTE_PRIVATE_CONFIG --plan|--apply');
  const c=JSON.parse(await fs.readFile(file,'utf8'));
  if(c.schemaVersion!==1||c.detachedConfirmation!=='RECONCILE DETACHED COPIES ONLY'||!Array.isArray(c.sides)||c.sides.length!==2||!path.isAbsolute(c.reportPath||''))throw Error('Explicit detached recovery configuration required.');
  for(const side of c.sides){
    if(!allowedDatabase(side.databaseName)||!path.isAbsolute(side.credentialsFile||'')||!path.isAbsolute(side.originalRuntimeBinding||''))throw Error('Protected original binding and detached credentials required.');
    const binding=JSON.parse(await fs.readFile(side.originalRuntimeBinding,'utf8'));
    if(binding.shopId!==c.shopId||!binding.database?.database||c.sides.some(s=>s.databaseName===binding.database.database))throw Error('A selected database is currently bound to a POS server.');
    const credentials=JSON.parse(await fs.readFile(side.credentialsFile,'utf8'));
    if(credentials.database!==side.databaseName||!['localhost','127.0.0.1','::1'].includes(credentials.host)||typeof credentials.user!=='string'||typeof credentials.password!=='string')throw Error('Detached credentials do not match.');
    side.credentials={host:credentials.host,user:credentials.user,password:credentials.password,database:credentials.database,supportBigNumbers:true,bigNumberStrings:true,connectionLimit:4};
  }
  if(c.sides[0].databaseName===c.sides[1].databaseName)throw Error('Distinct local/cloud staging databases required.');
  const pools=c.sides.map(side=>mysql.createPool(side.credentials));
  try{
    const report=await rebuildBaseline({pools,configuration:c,reportPath:c.reportPath,apply:mode==='--apply'});
    console.log(JSON.stringify({state:report.state,missing:report.missing,remaining:report.remaining,blockers:report.blockers.length,readyForEnrollment:report.readyForEnrollment,syncEnabled:false,reportPath:c.reportPath}));
    if(['blocked','needs-correction'].includes(report.state))process.exitCode=2;
  }finally{await Promise.all(pools.map(pool=>pool.end()));}
}
main().catch(()=>{console.error('Recovery rebuild stopped. Inspect the protected configuration/evidence; original databases were not activated or replaced.');process.exitCode=1;});
