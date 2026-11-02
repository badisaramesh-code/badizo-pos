const fs=require('node:fs/promises'),path=require('node:path'),assert=require('node:assert/strict'),mysql=require('mysql2/promise');
const {installSyncSchema}=require('../../backend/services/syncSchemaInstaller');
async function main(){
  const config=JSON.parse(await fs.readFile(process.argv[2],'utf8'));
  assert.match(config.database,/^badizo_recovery_[a-z0-9]+$/);
  assert.ok(['127.0.0.1','localhost'].includes(config.host));
  const connection=await mysql.createConnection({host:config.host,user:process.env.DB_USER||config.user,password:process.env.DB_PASSWORD||config.password,database:config.database});
  const directory=path.resolve(__dirname,'../../database/migrations');
  const options={connection,directory,expectedDatabase:config.database};
  try{
    const [tables]=await connection.query("SELECT TABLE_NAME AS name FROM information_schema.tables WHERE table_schema=DATABASE() AND table_name='sync_enrollment'");
    const before=tables.length?(await connection.query('SELECT * FROM sync_enrollment'))[0]:[];
    const [[counts]]=await connection.query('SELECT (SELECT COUNT(*) FROM invoices) AS invoices,(SELECT COUNT(*) FROM products) AS products');
    const plan=await installSyncSchema(options);assert.equal(plan.applied,false);assert.equal(plan.plan.length,10);
    await assert.rejects(installSyncSchema({...options,expectedDatabase:'wrong_database'}),/does not match/);
    let interrupted=false;
    const wrapped={query:connection.query.bind(connection),execute:async(sql,args)=>{
      if(!interrupted&&sql.startsWith("UPDATE sync_schema_migrations SET state='verified'")){interrupted=true;throw Error('Simulated process interruption after DDL');}
      return connection.execute(sql,args);
    }};
    await assert.rejects(installSyncSchema({...options,connection:wrapped,apply:true}),/Simulated process/);
    assert.equal(interrupted,true);
    assert.equal((await installSyncSchema({...options,apply:true})).applied,true);
    assert.equal((await installSyncSchema({...options,apply:true})).applied,true);
    const [ledger]=await connection.query('SELECT * FROM sync_schema_migrations');assert.equal(ledger.length,10);assert.ok(ledger.every(row=>row.state==='verified'));
    assert.deepEqual((await connection.query('SELECT * FROM sync_enrollment'))[0],before);
    assert.deepEqual((await connection.query('SELECT (SELECT COUNT(*) FROM invoices) AS invoices,(SELECT COUNT(*) FROM products) AS products'))[0][0],counts);
    console.log(JSON.stringify({realMysql:true,plan:true,wrongDatabaseRejected:true,interruptedInstallResumed:true,repeatedInstallSafe:true,enrollmentUnchanged:true,businessCountsUnchanged:true}));
  }finally{await connection.end();}
}
main().catch(error=>{console.error(error.message);process.exitCode=1;});
