const fs=require('fs'),path=require('path'),{spawnSync}=require('child_process');
const [root,output]=process.argv.slice(2);
if(!root||!output)throw Error('Root and output are required');
const env=require(path.join(root,'backend/node_modules/dotenv')).parse(fs.readFileSync(path.join(root,'backend/.env')));
const opt=output+'.cnf';
const quote=v=>'"'+String(v||'').replace(/\\/g,'\\\\').replace(/"/g,'\\"').replace(/\r/g,'\\r').replace(/\n/g,'\\n')+'"';
try {
 fs.writeFileSync(opt,['[client]','host='+quote(env.DB_HOST),'port='+Number(env.DB_PORT||3306),'user='+quote(env.DB_USER),'password='+quote(env.DB_PASSWORD)].join('\n'));
 const r=spawnSync(env.MYSQLDUMP_PATH,['--defaults-extra-file='+opt,'--single-transaction','--quick','--no-tablespaces','--result-file='+output,env.DB_NAME],{windowsHide:true,encoding:'utf8',timeout:600000});
 if(r.error||r.status!==0)throw Error('Database dump failed: '+(r.error?.message||r.stderr));
 if(fs.statSync(output).size<1000)throw Error('Database dump is unexpectedly small');
}finally{if(fs.existsSync(opt))fs.unlinkSync(opt)}
