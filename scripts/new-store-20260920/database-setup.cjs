const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const [mode, root, mysqlMode] = process.argv.slice(2);
if (!root || path.resolve(root).toLowerCase() !== 'c:\\badizopos') throw Error('Unexpected install root');
const mysql = require(path.join(root, 'backend/node_modules/mysql2/promise'));
const secretFile = path.join(root, 'install-secrets.json');
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function main() {
  if (mode === 'prepare' && !fs.existsSync(secretFile)) {
    const suffix=crypto.randomBytes(6).toString('hex');
    fs.writeFileSync(secretFile, JSON.stringify({mysqlMode:mysqlMode||'bundled',installId:crypto.randomBytes(24).toString('hex'),dbName:mysqlMode==='existing'?'badizo_new_'+suffix:'badizo_pos',dbUser:mysqlMode==='existing'?'bz_'+suffix:'badizo_app',rootPassword:crypto.randomBytes(24).toString('hex'),appPassword:crypto.randomBytes(24).toString('hex'),jwt:crypto.randomBytes(48).toString('hex')}));
  }
  const s = JSON.parse(fs.readFileSync(secretFile));
  if (mode === 'prepare') {
    if ((s.mysqlMode||'bundled')!==(mysqlMode||'bundled')) throw Error('MySQL installation mode changed; existing configuration preserved');
    fs.writeFileSync(path.join(root, 'NEW_STORE_CREDENTIALS.txt'), 'Keep private. MySQL localhost:3306 / database '+(s.dbName||'badizo_pos')+'\n'+(s.mysqlMode==='existing'?'Existing root password is unchanged and is not stored here.\n':'MySQL root password: '+s.rootPassword+'\n')+'Application DB user: '+(s.dbUser||'badizo_app')+'\nApplication DB password: '+s.appPassword+'\nPOS logins: see installation PDF.\n');
    const slash = root.replace(/\\/g,'/');
    fs.writeFileSync(path.join(root,'backend/.env'), [
      'DB_HOST=127.0.0.1','DB_PORT=3306','DB_USER='+(s.dbUser||'badizo_app'),'DB_PASSWORD='+s.appPassword,'DB_NAME='+(s.dbName||'badizo_pos'),
      'JWT_SECRET='+s.jwt,'HOST=0.0.0.0','PORT=5000','BADIZO_DISABLE_3000_REDIRECT=true',
      'BACKUP_DIR='+slash+'/backups','BACKUP_DAILY_TIME=09:00',
      'MYSQLDUMP_PATH='+slash+'/mysql/bin/mysqldump.exe','MYSQL_PATH='+slash+'/mysql/bin/mysql.exe',
      'BADIZO_NEW_STORE=true','BADIZO_ENABLE_LOCAL_BACKUP_SCHEDULE=false','GOOGLE_DRIVE_BACKUP_ENABLED=false','BADIZO_DISABLE_SCHEDULED_CLOUD_BACKUP=true'
    ].join('\n')+'\n');
    return;
  }
  if (mode === 'initialize') {
    let connection;
    for (let i=0;i<60&&!connection;i++) {
      for (const password of [s.rootPassword,'']) {
        try { connection=await mysql.createConnection({host:'127.0.0.1',port:3306,user:'root',password,connectTimeout:1500}); break; } catch {}
      }
      if (!connection) await sleep(1000);
    }
    if (!connection) throw Error('Cannot connect to this installer MySQL instance.');
    try {
      await connection.query("ALTER USER 'root'@'localhost' IDENTIFIED BY ?",[s.rootPassword]);
      await connection.query('CREATE DATABASE IF NOT EXISTS badizo_pos CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci');
      await connection.query("CREATE USER IF NOT EXISTS 'badizo_app'@'localhost' IDENTIFIED BY ?",[s.appPassword]);
      await connection.query("ALTER USER 'badizo_app'@'localhost' IDENTIFIED BY ?",[s.appPassword]);
      await connection.query("GRANT ALL PRIVILEGES ON badizo_pos.* TO 'badizo_app'@'localhost'");
    } finally { await connection.end(); }
    console.log('New-store database user configured.');
    return;
  }
  if (mode === 'verify') {
    for(let i=0;i<120;i++) {
      let c;
      try {
        c=await mysql.createConnection({host:'127.0.0.1',port:3306,user:s.dbUser||'badizo_app',password:s.appPassword,database:s.dbName||'badizo_pos'});
        const [rows]=await c.query("SELECT COUNT(*) n FROM users WHERE username IN ('server','counter6','security2')");
        await c.query('SELECT 1 FROM staff_salary_sheets LIMIT 1');
        await c.query('SELECT 1 FROM accounting_vouchers LIMIT 1');
        const r=await fetch('http://127.0.0.1:5000/',{signal:AbortSignal.timeout(2000)});
        const html=await r.text();
        if(rows[0].n===3 && r.ok && html.includes('<div id="root">')) { console.log('Schema, roles and UI ready.'); return; }
      } catch {} finally { if(c) await c.end(); }
      await sleep(1000);
    }
    throw Error('Database/UI did not become ready within 120 seconds.');
  }
}
main().catch(e=>{console.error(e.message);process.exitCode=1});
