'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),zlib=require('node:zlib'),crypto=require('node:crypto');
const {spawnSync}=require('node:child_process');

test('real daily entrypoint applies saved folder before lock/status and completes local-only backup',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'badizo-backup-entry-'));
  try {
    const root=path.join(dir,'saved'),fallback=path.join(dir,'env-default');
    fs.mkdirSync(path.join(root,'daily'),{recursive:true});
    const d=new Date(),p=n=>String(n).padStart(2,'0');
    const filename=`badizo_daily_${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())}_00-00-00.sql.gz`;
    fs.writeFileSync(path.join(root,'daily',filename),zlib.gzipSync(Buffer.concat([Buffer.from('-- MySQL dump\n'),crypto.randomBytes(4096)])));
    const preload=path.join(dir,'preload.cjs');
    fs.writeFileSync(preload,`
const Module=require('node:module'),fs=require('node:fs');const load=Module._load;
Module._load=function(id,parent,main){
 if(id.endsWith('dotenv'))return {config(){return {};}};
 if(id==='mysql2/promise')return {async createConnection(){return {async query(){return [[{setting_key:'backup_local_folder',setting_value:process.env.TEST_SAVED_FOLDER},{setting_key:'backup_drive_enabled',setting_value:'false'}]];},async end(){fs.writeFileSync(process.env.TEST_CONNECTION_CLOSED,'closed');}};}};
 return load.apply(this,arguments);
};
const cp=require('node:child_process');cp.spawn=cp.spawnSync=()=>{throw Error('Unexpected external command');};
global.fetch=()=>{throw Error('Unexpected network call');};
require('node:https').request=()=>{throw Error('Unexpected HTTPS call');};
`);
    const env={...process.env};for(const key of Object.keys(env))if(/^(BADIZO_|GOOGLE_|DB_)/.test(key))delete env[key];
    Object.assign(env,{BADIZO_CLOUD_BACKUP_DIR:fallback,GOOGLE_DRIVE_BACKUP_ENABLED:'true',TEST_SAVED_FOLDER:root,TEST_CONNECTION_CLOSED:path.join(dir,'closed')});
    const result=spawnSync(process.execPath,['--require',preload,path.resolve(__dirname,'../scripts/badizo_cloud_backup.js'),'daily'],{env,encoding:'utf8',timeout:15000});
    assert.equal(result.status,0,result.stderr||String(result.error));
    assert.equal(fs.readFileSync(path.join(dir,'closed'),'utf8'),'closed');
    const status=JSON.parse(fs.readFileSync(path.join(root,'backup-status.json'),'utf8'));
    assert.equal(status.localStatus,'success');assert.equal(status.cloudStatus,'disabled');assert.equal(status.file,filename);
    assert.equal(fs.existsSync(path.join(root,'backup-operation.lock')),false);
    assert.equal(fs.existsSync(fallback),false,'environment fallback must not receive status or lock');
    assert.equal(fs.existsSync(path.join(root,'daily',filename)),true);
  } finally {fs.rmSync(dir,{recursive:true,force:true});}
});
