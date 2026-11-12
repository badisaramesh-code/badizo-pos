const test=require('node:test');const assert=require('node:assert/strict');
const dbPath=require.resolve('../config/db');const authPath=require.resolve('../middleware/auth');
let queries=[],commits=0,rollbacks=0,fail=false,linked=false;
const c={beginTransaction:async()=>{},commit:async()=>{commits++},rollback:async()=>{rollbacks++},release:()=>{},query:async(sql,args=[])=>{
 queries.push({sql,args});
 if(sql.includes('FROM local_payment_diary WHERE create_request_id'))return [linked?[{id:8}]:[]];
 if(sql.includes('FROM local_account_ledgers'))return [[{account_name:'SUPPLIER'}]];
 if(sql.includes('FROM local_payment_diary_years'))return [[]];
 if(sql.includes('SELECT id FROM local_account_entries'))return [[{id:7}]];
 if(sql.includes('INSERT INTO local_payment_diary')&&fail)throw Error('failed reminder');
 return [{insertId:7,affectedRows:1}];
}};
require.cache[dbPath]={id:dbPath,filename:dbPath,loaded:true,exports:{getConnection:async()=>c}};
require.cache[authPath]={id:authPath,filename:authPath,loaded:true,exports:{authenticate:()=>{},authorize:()=>()=>{}}};
const router=require('../routes/localAccounts');
async function save(body,editing=false){queries=[];commits=0;rollbacks=0;let status=200,result;const route=router.stack.find(l=>l.route?.path===(editing?'/:id':'/')&&l.route.methods[editing?'put':'post']);await route.route.stack[0].handle({body,params:{id:7},user:{username:'admin'}},{status(n){status=n;return this},json(v){result=v}});return {status,result};}
const bill={account_scope:'NON_LOCAL',entry_date:'2026-11-01',account_name:'SUPPLIER',details:'BILL 23',cr_amount:'100',credit_days:'15'};
test('bill days atomically create the matching scoped diary reminder',async()=>{const r=await save(bill);assert.equal(r.status,200);assert.equal(commits,1);const row=queries.find(q=>q.sql.includes('INSERT INTO local_payment_diary'));assert.deepEqual(row.args.slice(0,6),['NON_LOCAL','SUPPLIER','LEDGER-7','2026-11-01','2026-11-16',100]);});
test('blank days skip diary; zero days is due on bill date',async()=>{await save({...bill,credit_days:''});assert.ok(!queries.some(q=>q.sql.includes('INSERT INTO local_payment_diary')));await save({...bill,credit_days:'0'});assert.equal(queries.find(q=>q.sql.includes('INSERT INTO local_payment_diary')).args[4],bill.entry_date);});
test('invalid days fail before any write',async()=>{for(const credit_days of ['-1','1.5','3651','abc']){assert.equal((await save({...bill,credit_days})).status,400);assert.equal(queries.length,0);}});
test('diary failure rolls back the bill',async()=>{fail=true;assert.equal((await save(bill)).status,500);assert.equal(rollbacks,1);assert.equal(commits,0);fail=false;});
test('linked bill edits are rejected',async()=>{linked=true;assert.equal((await save(bill,true)).status,409);assert.equal(commits,0);linked=false;});

test('DR bills also schedule their bill amount',async()=>{const r=await save({...bill,cr_amount:0,dr_amount:6783,credit_days:28,entry_date:'2026-10-15'});assert.equal(r.status,200);const row=queries.find(q=>q.sql.includes('INSERT INTO local_payment_diary'));assert.equal(row.args[4],'2026-11-12');assert.equal(row.args[5],6783);});
