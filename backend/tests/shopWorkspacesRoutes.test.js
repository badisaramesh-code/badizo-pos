const test = require('node:test');
const assert = require('node:assert/strict');
const {once} = require('node:events');
const express = require('express');
const jwt = require('jsonwebtoken');
const crypto = require('node:crypto');
const {JWT_SECRET} = require('../middleware/auth');

let query;
let actions;
const connection = {query:(...args)=>query(...args), beginTransaction:async()=>actions.push('begin'),
  commit:async()=>actions.push('commit'), rollback:async()=>actions.push('rollback'), release:()=>actions.push('release')};
require.cache[require.resolve('../config/db')] = {loaded:true,exports:{
  query:(...args)=>query(...args), getConnection:async()=>connection
}};
require.cache[require.resolve('../services/auditService')] = {loaded:true,exports:{writeAuditLog:async()=>{}}};

test('additional shop workspaces through authenticated HTTP',async t=>{
  const app=express();app.use(express.json());
  for(const name of ['gatePass','staffPayroll','quotations','specialOrders']) app.use('/'+name,require('../routes/'+name));
  const server=app.listen(0,'127.0.0.1');await once(server,'listening');
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  const base='http://127.0.0.1:'+server.address().port;
  function request(url,body,role='ADMIN') {
    return fetch(base+url,{method:body?'POST':'GET',headers:{Authorization:'Bearer '+jwt.sign({username:'qa',role},JWT_SECRET),'Content-Type':'application/json'},
      ...(body?{body:JSON.stringify(body)}:{})});
  }

  await t.test('security records an outgoing gate pass with loading times and a direction-specific number',async()=>{
    actions=[];let saved;
    query=async(sql,params)=>{
      if(sql.includes('COUNT(*) AS count')) {assert.deepEqual(params,['2026-05-01','OUT']);return [[{count:3}]];}
      if(sql.includes('INSERT INTO gate_pass_entries')) {saved=params;return [{affectedRows:1}];}
      if(sql.includes('WHERE pass_no = ?')) return [[{pass_no:saved[0],package_count:saved[22],movement_date:saved[2]}]];
      throw Error('Unexpected gate pass query');
    };
    const data={movement_type:'OUT',movement_date:'2026-05-01',party_name:'Supplier',supervisor_name:'Supervisor',security_person_name:'Guard',
      vehicle_no:'ka-test',loading_start_time:'10:00',loading_end_time:'10:30',unload_start_time:'09:00',package_count:6};
    assert.equal((await request('/gatePass',data,'COUNTER')).status,403);
    const res=await request('/gatePass',data,'SECURITY');assert.equal(res.status,200);
    const pass=await res.json();assert.equal(pass.pass_no,'GP-20260501-OUT-0004');assert.equal(pass.package_count,6);
    assert.deepEqual(saved.slice(4,8),[null,null,'10:00:00','10:30:00']);assert.equal(saved[13],'KA-TEST');
    assert.deepEqual(actions,['begin','commit','release']);
  });

  await t.test('monthly payroll combines attendance, overtime, bonus and deductions',async()=>{
    query=async(sql,params)=>{
      if(sql.includes('FROM staff_workers'))return [[{id:9,staff_name:'QA',salary_type:'DAILY',daily_wage:400,hourly_wage:50}]];
      if(sql.includes('FROM staff_attendance')) {
        assert.deepEqual(params,['2026-05-01','2026-05-31']);
        return [[{staff_id:9,status:'PRESENT',overtime_hours:2},{staff_id:9,status:'HALF_DAY'}]];
      }
      if(sql.includes('FROM staff_salary_sheets'))return [[{staff_id:9,bonus_amount:100,advance_amount:50,payment_status:'PAID'}]];
      throw Error('Unexpected payroll query');
    };
    const res=await request('/staffPayroll/monthly-sheet?month=2026-05');assert.equal(res.status,200);
    const result=await res.json(),row=result.rows[0];
    assert.equal(row.base_salary,600);assert.equal(row.overtime_amount,100);assert.equal(row.net_salary,750);
    assert.deepEqual(result.totals,{staff_count:1,net_salary:750,pending_salary:0,paid_salary:750});
  });

  await t.test('approved quotation derives GST and total from lines and advances the daily sequence',async()=>{
    actions=[];const salt='qa',pw='qa-quote-password';
    const hash=salt+':'+crypto.pbkdf2Sync(pw,salt,100000,64,'sha512').toString('hex');let header,line;
    query=async(sql,params)=>{
      if(sql.includes('FROM users'))return [[{username:'supervisor',is_active:1,role:'ADMIN',password_hash:hash}]];
      if(sql.includes('SELECT last_number'))return [[{last_number:9}]];
      if(sql.includes('INSERT INTO quotations'))header=params;
      else if(sql.includes('INSERT INTO quotation_items'))line=params;
      else if(!sql.includes('quotation_sequences')&&!sql.includes('audit_logs'))throw Error('Unexpected quote query');
      return [{affectedRows:1}];
    };
    const payload={items:[{product_name:'QA',quantity:2,sale_price:118,gst_percent:18}],grand_total:1};
    assert.equal((await request('/quotations',payload,'COUNTER')).status,400);
    assert.deepEqual(actions,['begin','rollback','release']);actions=[];
    const res=await request('/quotations',{...payload,approval:{username:'supervisor',password:pw}},'COUNTER');
    assert.equal(res.status,201);const body=await res.json();assert.match(body.quotation_no,/-0010$/);
    assert.equal(body.grand_total,'236.00');assert.deepEqual(header.slice(8,12),['200.00','36.00','0.00','236.00']);
    assert.equal(header.at(-1),'supervisor');assert.deepEqual(line.slice(-3),['200.00','36.00','236.00']);
    assert.deepEqual(actions,['begin','commit','release']);
  });

  await t.test('special-order final payment clears the receivable once and rejects further collection',async()=>{
    let paid=40;const amounts=[];actions=[];
    query=async(sql,params)=>{
      if(sql.includes('FROM special_orders')) return [[{order_no:'QA-1',total_amount:100,paid_amount:paid}]];
      if(sql.includes('INSERT INTO special_order_payments')) {amounts.push(params[2]);return [{insertId:5}];}
      if(sql.includes('UPDATE special_orders')) {assert.deepEqual(params,[100,0,'PAID','QA-1']);paid=params[0];return [{affectedRows:1}];}
      throw Error('Unexpected order query');
    };
    const url='/specialOrders/QA-1/payments';
    const result=await request(url,{amount:60});assert.equal(result.status,200);assert.equal((await result.json()).balance_due,0);
    assert.equal((await request(url,{amount:60})).status,400);
    assert.deepEqual(actions,['begin','commit','release','begin','rollback','release']);assert.deepEqual(amounts,[60]);
  });
});
