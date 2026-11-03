const fs=require('fs'),path=require('path');
async function bootstrapExisting(mysql,s,credentials,port=3306){
 if(!/^badizo_new_[a-f0-9]{12}$/.test(s.dbName)||!/^bz_[a-f0-9]{12}$/.test(s.dbUser))throw Error('Invalid new-store database identity');
 const c=await mysql.createConnection({host:'127.0.0.1',port,user:credentials.user,password:credentials.password,connectTimeout:10000});
 const db='\x60'+s.dbName+'\x60';
 try{
  const [[v]]=await c.query('SELECT VERSION() version');
  if(!/^8\.0\./.test(v.version))throw Error('Existing service must be MySQL 8.0');
  const [schemas]=await c.query('SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME=?',[s.dbName]);
  if(schemas.length){
   let marker;try{[[marker]]=await c.query('SELECT install_id FROM '+db+'.badizo_install_marker LIMIT 1')}catch{throw Error('Existing database has no matching installer ownership marker; preserved')}
   if(marker?.install_id!==s.installId)throw Error('Database ownership mismatch; preserved');
  }else{
   const [accounts]=await c.query('SELECT User FROM mysql.user WHERE User=?',[s.dbUser]);
   if(accounts.length)throw Error('Generated application account already exists; preserved');
   await c.query('CREATE DATABASE '+db+' CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci');
   await c.query('CREATE TABLE '+db+'.badizo_install_marker (install_id VARCHAR(64) PRIMARY KEY)');
   await c.query('INSERT INTO '+db+'.badizo_install_marker VALUES (?)',[s.installId]);
  }
  const [accounts]=await c.query("SELECT User FROM mysql.user WHERE User=? AND Host='localhost'",[s.dbUser]);
  if(!accounts.length)await c.query("CREATE USER ?@'localhost' IDENTIFIED BY ?",[s.dbUser,s.appPassword]);
  else{
   let app;try{app=await mysql.createConnection({host:'127.0.0.1',port,user:s.dbUser,password:s.appPassword,connectTimeout:5000})}
   catch{throw Error('Existing application account does not match installer credentials; preserved')}
   finally{if(app)await app.end()}
  }
  await c.query("GRANT ALL PRIVILEGES ON "+db+".* TO ?@'localhost'",[s.dbUser]);
  console.log('Existing MySQL 8.0 reused. New-store database: '+s.dbName+'. Existing databases/root password preserved.');
 }finally{await c.end()}
}
module.exports={bootstrapExisting};
if(require.main===module){
 const root=process.argv[2];
 if(!root||path.resolve(root).toLowerCase()!=='c:\\badizopos')throw Error('Unexpected install root');
 const mysql=require(path.join(root,'backend/node_modules/mysql2/promise'));
 let input='';process.stdin.setEncoding('utf8');process.stdin.on('data',c=>input+=c);
 process.stdin.on('end',async()=>{try{const credentials=JSON.parse(input.replace(/^\uFEFF/,''));input='';const s=JSON.parse(fs.readFileSync(path.join(root,'install-secrets.json')));await bootstrapExisting(mysql,s,credentials);credentials.password=''}catch(e){console.error(e.message);process.exitCode=1}});
}
