// Isolated integration check: creates only its own disposable test database.
const fs=require('fs');
const path=require('path');
const mysql=require('mysql2/promise');
const dotenv=require('dotenv');
const assert=require('node:assert/strict');
const {ensureSchema,createService}=require('../services/paymentDiary');
async function main(){
  const env=dotenv.parse(fs.readFileSync(path.resolve(__dirname,'../.env')));
  const config={host:env.DB_HOST||'localhost',port:Number(env.DB_PORT||3306),user:env.DB_USER||'root',password:env.DB_PASSWORD,connectTimeout:5000,dateStrings:true};
  const database=`badizo_diary_test_${process.pid}_${Date.now()}`;
  assert.match(database,/^badizo_diary_test_\d+_\d+$/);
  assert.notEqual(database,env.DB_NAME);
  const admin=await mysql.createConnection(config);let pool,created=false;
  try{
    await admin.query(`CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4`);created=true;
    pool=mysql.createPool({...config,database,connectionLimit:4});
    await pool.query(`CREATE TABLE local_account_ledgers(id BIGINT AUTO_INCREMENT PRIMARY KEY,account_scope VARCHAR(20),account_name VARCHAR(180)) ENGINE=InnoDB`);
    await pool.query(`CREATE TABLE local_account_entries(id BIGINT AUTO_INCREMENT PRIMARY KEY,account_scope VARCHAR(20),entry_date DATE,account_name VARCHAR(180),details VARCHAR(255),remarks VARCHAR(255),dr_amount DECIMAL(12,2),cr_amount DECIMAL(12,2),created_by VARCHAR(100)) ENGINE=InnoDB`);
    await ensureSchema(pool);await ensureSchema(pool);
    await pool.query("INSERT INTO local_account_ledgers(account_scope,account_name) VALUES('LOCAL','TEST SUPPLIER'),('NON_LOCAL','TEST OUTSIDE')");
    const service=createService(pool,{today:()=> '2026-11-11'});
    const record=await service.add({account_scope:'LOCAL',account_name:'TEST SUPPLIER',bill_no:'TEST-1',bill_date:'2025-10-01',due_date:'2025-11-01',amount:'100',request_id:'mysql-reminder-123456'},'test');
    const p={payment_date:'2026-11-11',paid_amount:'40',discount_amount:'10',payment_mode:'Bank',bank_name:'TEST BANK',reference_no:'TEST-UTR',request_id:'mysql-payment-123456'};
    assert.equal((await service.pay(record.id,p,'test')).pending_amount,50);
    assert.equal((await service.pay(record.id,p,'test')).duplicate,true);
    const current=await service.list({year:2026,scope:'LOCAL'});
    assert.equal(current.rows[0].pending_amount,50);assert.equal(current.rows[0].carried_forward,true);assert.equal(current.summary.due,50);
    const old=await service.list({year:2025,scope:'LOCAL'});assert.equal(old.rows[0].pending_amount,100);
    const remaining={...p,paid_amount:'50',discount_amount:'0'};
    const concurrent=await Promise.allSettled([service.pay(record.id,{...remaining,request_id:'concurrent-payment-a'},'test-a'),service.pay(record.id,{...remaining,request_id:'concurrent-payment-b'},'test-b')]);
    assert.equal(concurrent.filter(r=>r.status==='fulfilled').length,1);
    const saved=concurrent.find(r=>r.status==='fulfilled').value;
    await service.reverse(saved.id,{reversal_date:'2026-11-11',reason:'Integration test reversal',request_id:'mysql-reversal-123456'},'test');
    assert.equal((await service.list({year:2026})).rows[0].pending_amount,50);
    const history=await service.history(record.id);assert.equal(history.length,2);assert.equal(history[1].reversed_date,'2026-11-11');
    const [ledger]=await pool.query('SELECT SUM(dr_amount) AS dr,SUM(cr_amount) AS cr,COUNT(*) AS entries FROM local_account_entries');
    assert.equal(Number(ledger[0].dr)-Number(ledger[0].cr),50);assert.equal(ledger[0].entries,4);
    await service.closeYear({year:2025},'test');
    await assert.rejects(service.add({account_scope:'LOCAL',account_name:'TEST SUPPLIER',bill_no:'TEST-2',bill_date:'2025-10-01',due_date:'2025-11-01',amount:'100',request_id:'closed-reminder-123456'},'test'),/closed financial year/);
    const matches=await service.accounts({scope:'NON_LOCAL',search:'TEST'});assert.deepEqual(matches.map(r=>r.account_name),['TEST OUTSIDE']);
    const editable=await service.add({account_scope:'NON_LOCAL',account_name:'TEST OUTSIDE',bill_no:'EDIT-TEST',bill_date:'2026-11-01',due_date:'2026-11-10',amount:'200',request_id:'editable-reminder-12345'},'test');
    await service.modify(editable.id,{account_scope:'NON_LOCAL',account_name:'TEST OUTSIDE',bill_no:'EDIT-TEST',bill_date:'2026-11-01',due_date:'2026-11-20',amount:'250',notes:'Corrected',reason:'Correction',version:0,request_id:'mysql-edit-123456'},'test');
    const modified=(await service.list({scope:'NON_LOCAL'})).rows[0];assert.equal(Number(modified.amount),250);assert.ok(modified.version>0);
    await service.modify(editable.id,{reason:'Duplicate',version:modified.version,request_id:'mysql-delete-123456'},'test','DELETE');
    assert.equal((await service.list({scope:'NON_LOCAL'})).rows.length,0);
    const deleted=(await service.list({scope:'NON_LOCAL',status:'DELETED'})).rows[0];assert.equal(deleted.is_deleted,true);
    await assert.rejects(service.pay(editable.id,{...p,request_id:'deleted-payment-123456'},'test'),/deleted/);
    await service.modify(editable.id,{reason:'Restore',version:deleted.version,request_id:'mysql-restore-123456'},'test','RESTORE');
    assert.equal((await service.list({scope:'NON_LOCAL'})).rows[0].pending_amount,250);
    assert.equal((await service.changes(editable.id)).length,3);
    console.log('PASS: isolated MySQL schema, FY carry-forward, partial payment, discount, concurrency, reversal, scope, edit history, recoverable delete and restore.');
  }finally{
    if(pool)await pool.end();
    if(created){assert.match(database,/^badizo_diary_test_\d+_\d+$/);await admin.query(`DROP DATABASE \`${database}\``);}
    await admin.end();
  }
}
main().catch(error=>{console.error(error.message);process.exitCode=1;});
