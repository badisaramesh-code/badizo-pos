const test = require('node:test');
const assert = require('node:assert/strict');
const {once} = require('node:events');
const express = require('express');
const jwt = require('jsonwebtoken');
const {JWT_SECRET} = require('../middleware/auth');

let transaction;
const restored = [];
const mock = (modulePath, exports) => { require.cache[require.resolve(modulePath)] = {exports, loaded:true}; };
mock('../config/db', {getConnection: async () => transaction});
mock('../services/auditService', {writeAuditLog: async () => {}});
mock('../services/backupService', {restoreDatabaseBackup: async file => {
  restored.push(file); return {file};
}});
const app = express();
app.use(express.json());
app.use('/billing', require('../routes/billing'));
app.use('/inward', require('../routes/inward'));
app.use('/backup', require('../routes/backup'));

function isolatedTransaction(query) {
  const actions = [];
  transaction = {query, beginTransaction:async()=>actions.push('begin'),commit:async()=>actions.push('commit'),
    rollback:async()=>actions.push('rollback'),release:()=>actions.push('release')};
  return actions;
}

test('local POS purchase, return and restore HTTP regressions', async t => {
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = 'http://127.0.0.1:' + server.address().port;
  function post(endpoint, body, role='ADMIN') {
    const headers = {'Content-Type':'application/json'};
    if (role) headers.Authorization = 'Bearer ' + jwt.sign({role,username:'qa'}, JWT_SECRET);
    return fetch(base + endpoint, {method:'POST', headers, body:JSON.stringify(body),signal:AbortSignal.timeout(5000)});
  }

  await t.test('supplier payment settles the correct purchase and publishes its new balance after commit', async()=>{
    const purchase = {inward_no:'IN-1',supplier_name:'QA',grand_total:123.50,paid_amount:23.50,due_amount:100};
    let payment, balance;
    const actions = isolatedTransaction(async(sql,params)=>{
      if (sql.includes('FROM inward_entries')) {assert.deepEqual(params,['IN-1']);assert.match(sql,/FOR UPDATE/);return [[purchase]];}
      if (sql.includes('INSERT INTO supplier_payments')) {payment=params;return [{insertId:8}];}
      if (sql.includes('UPDATE inward_entries')) {balance=params;return [{affectedRows:1}];}
      throw Error('Unexpected query');
    });
    const response = await post('/inward/supplier-payments',{inward_no:'IN-1',amount:100});
    assert.equal(response.status,200);
    const result=await response.json();
    assert.equal(result.payment_status,'PAID');assert.equal(result.due_amount,0);
    assert.equal(payment[0],'IN-1');assert.equal(payment[4],100);
    assert.deepEqual(balance,[123.5,0,'PAID','IN-1']);
    assert.deepEqual(actions,['begin','commit','release']);
  });

  await t.test('supplier overpayment and failed balance update both roll back', async()=>{
    for(const [amount,failAfterInsert] of [[101,false],[50,true]]) {
      let inserted=false;
      const actions=isolatedTransaction(async sql=>{
        if(sql.includes('FROM inward_entries')) return [[{grand_total:100,paid_amount:0,due_amount:100}]];
        if(sql.includes('INSERT INTO supplier_payments')) {inserted=true;return [{insertId:1}];}
        throw Error('simulated balance write failure');
      });
      const response=await post('/inward/supplier-payments',{inward_no:'IN-1',amount});
      assert.equal(response.status,400);assert.equal(inserted,failAfterInsert);
      assert.deepEqual(actions,['begin','rollback','release']);
    }
  });

  await t.test('invalid sale returns roll back provisional refund and never restock',async()=>{
    for(const item of [{quantity:2,returned_qty:1,is_free_bonus:0},{quantity:3,returned_qty:0,is_free_bonus:1}]) {
      const writes=[];
      const actions=isolatedTransaction(async(sql,params)=>{
        if(sql.includes('FROM invoices')) return [[{invoice_status:'PAID'}]];
        if(sql.includes('INSERT INTO sales_returns')) {writes.push('header');return [{insertId:1}];}
        if(sql.includes('FROM invoice_items')) {assert.deepEqual(params,[1,'QA-1']);return [[{...item,product_name:'Item'}]];}
        writes.push('unexpected');throw Error('Unexpected stock or refund write');
      });
      const response=await post('/billing/return',{invoice_no:'QA-1',reason:'QA',items:[{invoice_item_id:1,quantity:2}]});
      assert.equal(response.status,400);assert.match((await response.json()).error,/cannot exceed|cannot be returned/i);assert.deepEqual(writes,['header']);
      assert.deepEqual(actions,['begin','rollback','release']);
    }
  });

  await t.test('partial taxable return restores the sold batches and records the matching refund in one transaction',async()=>{
    const writes={batch:[],batchHistory:[]};
    const actions=isolatedTransaction(async(sql,params)=>{
      if(sql.includes('FROM invoices')) return [[{invoice_status:'PAID'}]];
      if(sql.includes('COUNT(*) AS remaining')) return [[{remaining:1}]];
      if(sql.includes('FROM invoice_items')) return [[{barcode:'QA',product_name:'Sample',quantity:5,returned_qty:1,sale_price:118,gst_percent:18,is_free_bonus:0}]];
      if(sql.includes('FROM invoice_item_batches')) return [[
        {id:31,barcode:'QA',batch_no:'B2',expiry_date:null,quantity:2,returned_qty:1},
        {id:30,barcode:'QA',batch_no:'B1',expiry_date:'2027-05-01',quantity:3,returned_qty:0}
      ]];
      if(sql.includes('UPDATE product_batches')) writes.batch.push(params);
      else if(sql.includes('UPDATE invoice_item_batches')) writes.batchHistory.push(params);
      else if(sql.includes('UPDATE invoice_items')) writes.items=params;
      else if(sql.includes('UPDATE products')) writes.stock=params;
      else if(sql.includes('UPDATE sales_returns')) writes.refund=params;
      else if(sql.includes('UPDATE invoices')) writes.invoice=params;
      else if(!sql.includes('INSERT INTO sales_return')) throw Error('Unexpected return query');
      return [{affectedRows:1,insertId:1}];
    });
    const response=await post('/billing/return',{invoice_no:'QA-1',reason:'QA',refund_mode:'Cash',items:[{invoice_item_id:12,quantity:2}]});
    assert.equal(response.status,200);
    const result=await response.json();
    assert.deepEqual(writes.items,[2,12]);assert.deepEqual(writes.stock,[2,'QA']);
    assert.deepEqual(writes.batch,[[1,'QA','B2',null],[1,'QA','B1','2027-05-01']]);
    assert.deepEqual(writes.batchHistory,[[1,31],[1,30]]);
    assert.deepEqual(writes.refund,[200,36,236,result.return_no]);
    assert.deepEqual(writes.invoice,['PARTIALLY_RETURNED','QA-1']);
    assert.equal(result.refund_total,236);
    assert.deepEqual(actions,['begin','commit','release']);
  });

  await t.test('restore requires authenticated privileged login and exact confirmation before invoking restore',async()=>{
    const input={file:'daily.sql.gz',confirmation:'RESTORE BADIZO POS'};
    assert.equal((await post('/backup/restore',input,null)).status,401);
    assert.equal((await post('/backup/restore',input,'COUNTER')).status,403);
    assert.equal((await post('/backup/restore',{...input,confirmation:'yes'})).status,400);
    assert.deepEqual(restored,[]);
    assert.equal((await post('/backup/restore',input)).status,200);
    assert.deepEqual(restored,['daily.sql.gz']);
  });
});
