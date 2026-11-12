const test=require('node:test');
const assert=require('node:assert/strict');
const {createService,date,money,fy,ensureSchema}=require('../services/paymentDiary');

function fixture() {
  let state={diary:[{id:1,account_scope:'LOCAL',account_name:'SUPPLIER',bill_no:'INV-1',bill_date:'2026-10-01',due_date:'2026-11-01',amount:'100.00',notes:''}],payments:[],entries:[],closed:[],changes:[]};
  let tail=Promise.resolve();const queries=[];
  async function query(sql,args=[]) {
    queries.push({sql,args});assert.equal((sql.match(/\?/g)||[]).length,args.length,`Parameter count: ${sql}`);
    if(state.failOnPaymentInsert&&sql.includes('INSERT INTO local_payment_diary_payments'))throw Error('Simulated payment insert failure');
    if(sql.includes('FROM local_payment_diary_changes WHERE request_id'))return [state.changes.filter(r=>r.request_id===args[0])];
    if(sql.includes('FROM local_payment_diary_changes WHERE diary_id')){const changes=state.changes.filter(r=>r.diary_id===args[0]);return [[{version:Math.max(0,...changes.map(r=>r.id)),deleted:Math.max(0,...changes.filter(r=>r.change_type==='DELETE').map(r=>r.id)),restored:Math.max(0,...changes.filter(r=>r.change_type==='RESTORE').map(r=>r.id))}]];}
    if(sql.includes('INSERT INTO local_payment_diary_changes')){const names=['diary_id','change_type','event_date','reason','changes_json','request_id','request_hash','created_by'];const row=Object.fromEntries(names.map((name,i)=>[name,args[i]]));row.id=state.changes.length+1;state.changes.push(row);return [{insertId:row.id}];}
    if(sql.includes('UPDATE local_payment_diary SET')){const names=['account_scope','account_name','bill_no','bill_date','due_date','amount','notes'];Object.assign(state.diary.find(r=>r.id===args[7]),Object.fromEntries(names.map((name,i)=>[name,args[i]])));return [{}];}
    if(sql.includes('FROM local_account_ledgers'))return [[{account_name:'SUPPLIER'}]];
    if(sql.includes('FROM local_payment_diary_years'))return [state.closed.filter(r=>r.year_start===args[0])];
    if(sql.includes('FROM local_payment_diary WHERE create_request_id'))return [state.diary.filter(r=>r.create_request_id===args[0])];
    if(sql.includes('FROM local_payment_diary WHERE id='))return [state.diary.filter(r=>r.id===args[0])];
    if(sql.includes('FROM local_payment_diary_payments WHERE request_id'))return [state.payments.filter(r=>r.request_id===args[0])];
    if(sql.includes('SELECT diary_id'))return [state.payments.filter(r=>r.id===args[0]).map(r=>({diary_id:r.diary_id}))];
    if(sql.includes('FROM local_payment_diary_payments WHERE id='))return [state.payments.filter(r=>r.id===args[0])];
    if(sql.includes(' AS settled')){const rows=state.payments.filter(r=>r.diary_id===args[0]&&!r.reversed_date);return [[{settled:rows.reduce((s,r)=>s+r.paid_amount+r.discount_amount,0),last_payment:rows.map(r=>r.payment_date).sort().at(-1)||null}]];}
    if(sql.includes('INSERT INTO local_account_entries')){state.entries.push({id:state.entries.length+1,scope:args[0],date:args[1],name:args[2],details:args[3],remarks:args[4],dr:args[5],cr:args[6]});return [{insertId:state.entries.length}];}
    if(sql.includes('INSERT INTO local_payment_diary_payments')){const names=['diary_id','payment_date','paid_amount','discount_amount','payment_mode','bank_name','reference_no','notes','request_id','request_hash','payment_entry_id','discount_entry_id','created_by'];const row=Object.fromEntries(names.map((name,i)=>[name,args[i]]));row.id=state.payments.length+1;state.payments.push(row);return [{insertId:row.id}];}
    if(sql.includes('INSERT INTO local_payment_diary\n')){const names=['account_scope','account_name','bill_no','bill_date','due_date','amount','notes','create_request_id','request_hash','created_by'];const row=Object.fromEntries(names.map((name,i)=>[name,args[i]]));row.id=state.diary.length+1;state.diary.push(row);return [{insertId:row.id}];}
    if(sql.includes('UPDATE local_payment_diary_payments')){Object.assign(state.payments.find(r=>r.id===args[6]),{reversed_date:args[0],reversed_by:args[1],reversal_reason:args[2],reversal_request_id:args[3],reversal_payment_entry_id:args[4],reversal_discount_entry_id:args[5]});return [{affectedRows:1}];}
    if(sql.includes('INSERT IGNORE INTO local_payment_diary_years')){state.closed.push({year_start:args[0],closed_by:args[1]});return [{}];}
    throw Error(`Unexpected SQL: ${sql}`);
  }
  const pool={query,getConnection:async()=>{let snapshot,unlock;return {query,
    async beginTransaction(){const previous=tail;tail=new Promise(resolve=>{unlock=resolve;});await previous;snapshot=structuredClone(state);},
    async commit(){},async rollback(){state=snapshot;},release(){unlock();}};}};
  return {service:createService(pool,{today:()=> '2026-11-11'}),get state(){return state;},queries,pool};
}
const payment=(overrides={})=>({payment_date:'2026-11-11',paid_amount:'95.00',discount_amount:'5.00',payment_mode:'Bank',bank_name:'HDFC',reference_no:'UTR-1',request_id:'payment-request-123',...overrides});

test('strict financial dates and amounts reject malformed input',()=>{
  for(const value of ['2026-02-30','2026-13-01','2026-1-01',''])assert.throws(()=>date(value),e=>e.status===400);
  for(const value of ['-1','1.234','NaN','1e4',''])assert.throws(()=>money(value,'Amount'),e=>e.status===400);
  assert.equal(money('123.45','Amount'),12345);assert.equal(fy('2026-03-31'),2025);assert.equal(fy('2026-04-01'),2026);
});
test('schema contains only Local/Non-Local diary tables',async()=>{
  const sql=[];await ensureSchema({query:async value=>sql.push(value)});assert.equal(sql.length,4);
  assert.ok(sql.every(value=>value.includes('CREATE TABLE IF NOT EXISTS local_payment_diary')));
});
test('adding a reminder never duplicates a purchase in the ledger',async()=>{
  const f=fixture();const body={account_scope:'LOCAL',account_name:'SUPPLIER',bill_no:'NEW',bill_date:'2026-11-01',due_date:'2026-11-15',amount:'200',request_id:'reminder-request-123'};
  const first=await f.service.add(body,'admin');assert.equal(first.id,2);assert.equal(f.state.entries.length,0);
  const retry=await f.service.add(body,'admin');assert.equal(retry.duplicate,true);assert.equal(f.state.diary.length,2);
  await assert.rejects(f.service.add({...body,amount:'300'},'admin'),e=>e.status===409);
});
test('payment and discount atomically post separate CR ledger entries',async()=>{
  const f=fixture();const result=await f.service.pay(1,payment(),'admin');assert.equal(result.pending_amount,0);
  assert.deepEqual(f.state.entries.map(r=>[r.scope,r.name,r.dr,r.cr]),[['LOCAL','SUPPLIER',0,95],['LOCAL','SUPPLIER',0,5]]);
  assert.match(f.state.entries[0].details,/PAYMENT BANK/);assert.match(f.state.entries[1].details,/DISCOUNT/);
  assert.match(f.state.entries[0].remarks,/HDFC.*UTR-1/);
  const retry=await f.service.pay(1,payment(),'admin');assert.equal(retry.duplicate,true);assert.equal(f.state.entries.length,2);
  await assert.rejects(f.service.pay(1,payment({paid_amount:'90'}),'admin'),e=>e.status===409);
});
test('Non-Local partial payments stay in the selected ledger and enforce remaining balance',async()=>{
  const f=fixture();f.state.diary[0].account_scope='NON_LOCAL';
  assert.equal((await f.service.pay(1,payment({paid_amount:'40',discount_amount:'5'}),'admin')).pending_amount,55);
  await assert.rejects(f.service.pay(1,payment({paid_amount:'56',discount_amount:'0',request_id:'next-payment-123'}),'admin'),/exceeds/);
  assert.equal(f.state.entries.length,2);
  assert.equal((await f.service.pay(1,payment({paid_amount:'55',discount_amount:'0',request_id:'next-payment-123'}),'admin')).pending_amount,0);
  assert.ok(f.state.entries.every(r=>r.scope==='NON_LOCAL'));
});
test('concurrent full payments cannot settle the same pending balance twice',async()=>{
  const f=fixture();const results=await Promise.allSettled([f.service.pay(1,payment(),'admin'),f.service.pay(1,payment({request_id:'other-payment-123'}),'admin2')]);
  assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal(f.state.payments.length,1);assert.equal(f.state.entries.length,2);
});
test('a failure after writing ledger entries rolls back the entire payment and discount',async()=>{
  const f=fixture();f.state.failOnPaymentInsert=true;
  await assert.rejects(f.service.pay(1,payment(),'admin'),/Simulated/);
  assert.equal(f.state.entries.length,0);assert.equal(f.state.payments.length,0);
});
test('reversal retains originals, adds opposite entries and permits settlement again',async()=>{
  const f=fixture();await f.service.pay(1,payment(),'admin');const body={reversal_date:'2026-11-11',reason:'Wrong bank selected',request_id:'reverse-request-123'};
  await f.service.reverse(1,body,'owner');assert.equal(f.state.payments[0].reversed_by,'owner');assert.equal(f.state.entries.length,4);
  assert.equal(f.state.entries.reduce((sum,r)=>sum+r.dr-r.cr,0),0);
  await f.service.reverse(1,body,'owner');assert.equal(f.state.entries.length,4);
  await f.service.pay(1,payment({request_id:'correct-payment-123'}),'owner');assert.equal(f.state.payments.length,2);
});
test('future and prior-year payment dates, missing bank, and over-settlement are rejected without ledger writes',async()=>{
  for(const override of [{payment_date:'2026-11-12'},{payment_date:'2026-03-31'},{bank_name:''},{paid_amount:'100',discount_amount:'1'}]){
    const f=fixture();await assert.rejects(f.service.pay(1,payment(override),'admin'));assert.equal(f.state.entries.length,0);
  }
});
test('only completed financial years can be closed; no entries are copied or deleted',async()=>{
  const f=fixture();await assert.rejects(f.service.closeYear({year:2026},'admin'));await f.service.closeYear({year:2025},'admin');
  assert.equal(f.state.closed[0].year_start,2025);assert.equal(f.state.entries.length,0);assert.equal(f.state.diary.length,1);
});
test('year view retains unpaid previous-year balances and excludes fully paid inactive old bills',async()=>{
  let params;
  const service=createService({query:async(sql,args=[])=>{
    assert.equal((sql.match(/\?/g)||[]).length,args.length);
    if(sql.includes('LEFT JOIN')){params=args;return [[
      {id:1,bill_date:'2025-01-01',due_date:'2025-02-01',amount:100,paid_amount:30,discount_amount:10,period_activity:0},
      {id:2,bill_date:'2025-01-01',due_date:'2025-02-01',amount:100,paid_amount:100,discount_amount:0,period_activity:0},
      {id:3,bill_date:'2026-11-01',due_date:'2026-11-20',amount:50,paid_amount:0,discount_amount:0,period_activity:0}
    ]];}
    if(sql.includes('MIN(bill_date)'))return [[{earliest:'2025-01-01'}]];
    return [[]];
  }},{today:()=> '2026-11-11'});
  const result=await service.list({year:2026});assert.deepEqual(result.rows.map(r=>r.id),[1,3]);assert.equal(result.rows[0].carried_forward,true);
  assert.equal(result.summary.pending,110);assert.equal(result.summary.due,60);assert.equal(result.summary.upcoming,50);
  assert.equal(params[0],'2026-11-11');
});
const editBody=(override={})=>({account_scope:'LOCAL',account_name:'SUPPLIER',bill_no:'INV-1',bill_date:'2026-10-01',due_date:'2026-11-20',amount:'120',notes:'Corrected',reason:'Wrong due amount',version:0,request_id:'edit-reminder-123456',...override});
test('unpaid reminder can be edited without adding or changing ledger entries',async()=>{
  const f=fixture();await f.service.modify(1,editBody(),'admin');assert.equal(f.state.diary[0].amount,120);assert.equal(f.state.changes[0].change_type,'EDIT');assert.equal(f.state.entries.length,0);
  await f.service.modify(1,editBody(),'admin');assert.equal(f.state.changes.length,1);
  await assert.rejects(f.service.modify(1,editBody({request_id:'other-edit-123456'}),'admin'),/changed on another screen/);
});
test('delete is recoverable, does not touch the ledger and blocks further payments until restored',async()=>{
  const f=fixture();await f.service.modify(1,{reason:'Duplicate reminder',version:0,request_id:'delete-reminder-123456'},'admin','DELETE');
  assert.equal(f.state.diary.length,1);assert.equal(f.state.entries.length,0);
  await assert.rejects(f.service.pay(1,payment(),'admin'),/deleted/);
  await f.service.modify(1,{reason:'Restore correct reminder',version:1,request_id:'restore-reminder-12345'},'admin','RESTORE');
  await assert.rejects(f.service.pay(1,payment(),'admin'),/was edited/);
  await f.service.pay(1,payment({version:2}),'admin');assert.equal(f.state.payments.length,1);
});
test('posted payments protect amount and deletion, but permit due-date and remark edits',async()=>{
  const f=fixture();await f.service.pay(1,payment({paid_amount:'40',discount_amount:'0'}),'admin');
  await assert.rejects(f.service.modify(1,editBody(),'admin'),/Reverse them/);
  await assert.rejects(f.service.modify(1,{reason:'Delete',version:0,request_id:'delete-reminder-123456'},'admin','DELETE'),/Reverse them/);
  await f.service.modify(1,editBody({amount:'100'}),'admin');assert.equal(f.state.diary[0].due_date,'2026-11-20');assert.equal(f.state.entries.length,1);
});

test('Bank and UPI payments save without a transaction reference',async()=>{
 for(const payment_mode of ['Bank','UPI']){
  const f=fixture();const result=await f.service.pay(1,payment({payment_mode,reference_no:''}),'admin');
  assert.equal(result.pending_amount,0);assert.equal(f.state.payments[0].reference_no,'');
 }
});

test('Sunday reminders move to Saturday without changing other weekdays',()=>{const {reminderDate}=require('../services/paymentDiary');assert.equal(reminderDate('2026-11-15'),'2026-11-14');assert.equal(reminderDate('2026-11-14'),'2026-11-14');assert.equal(reminderDate('2026-11-16'),'2026-11-16');assert.equal(reminderDate('2026-11-01'),'2026-10-31');assert.equal(reminderDate('2023-01-01'),'2022-12-31');});

test('all payment modes credit both Local and Non-Local ledgers; reversals debit them',async()=>{for(const scope of ['LOCAL','NON_LOCAL'])for(const payment_mode of ['Cash','Bank','UPI']){const f=fixture();f.state.diary[0].account_scope=scope;await f.service.pay(1,payment({payment_mode}),'admin');assert.deepEqual(f.state.entries.map(r=>[r.dr,r.cr]),[[0,95],[0,5]]);await f.service.reverse(1,{reversal_date:'2026-11-11',reason:'Correction',request_id:'reverse-credit-123'},'admin');assert.deepEqual(f.state.entries.slice(2).map(r=>[r.dr,r.cr]),[[95,0],[5,0]]);}});
