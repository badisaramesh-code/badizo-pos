'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {EventEmitter} = require('node:events');
const Module = require('node:module');
const dbPath = require.resolve('../config/db');
const db = new Module(dbPath);
const writes = [];
db.exports = {query: async (sql, args) => { writes.push({sql,args}); return [{}]; }};
require.cache[dbPath] = db;
const {writeAuditLog, recordRequestFailure} = require('../services/auditService');
const reprints = require('../services/invoiceReprints');

async function request(method,status,user,area='billing') {
  const res = Object.assign(new EventEmitter(),{statusCode:status});
  recordRequestFailure({user, method, route:{path:'/checkout'}, originalUrl:'/api/'+area+'/checkout?secret=value'},res,()=>{});
  res.emit('finish');
  await new Promise(resolve=>setImmediate(resolve));
}

test('one thousand successful sales produce no audit reads or writes; rejected checkout records only safe fields', async () => {
  const user = {id:1,role:'COUNTER',username:'counter1'};
  for (let i=0;i<1000;i++) {
    await writeAuditLog({user,action:'INVOICE_CREATED'});
    await request('POST',201,user);
  }
  await request('GET',404,user);
  await request('POST',401,null);
  await request('GET',500,user,'audit');
  assert.equal(writes.length,0);
  await request('POST',409,user);
  assert.equal(writes.length,1);
  assert.match(writes[0].sql,/INSERT INTO audit_logs/);
  assert.deepEqual(JSON.parse(writes[0].args.at(-1)),{method:'POST',route:'/checkout',status:409});
});

test('reprint count and its report entry commit together and never write audit history',async()=>{
  const calls = [];
  const conn = {
    beginTransaction: async()=>{},commit:async()=>calls.push('commit'),rollback:async()=>calls.push('rollback'),
    release:()=>{},query:async(sql)=>{calls.push(sql);return [{affectedRows:1}];}
  };
  const pool={getConnection:async()=>conn};
  assert.equal(await reprints.record(pool,'INV','owner','A4'),true);
  assert.match(calls[1],/INSERT INTO invoice_reprints/);
  assert.equal(calls[2],'commit');
  conn.query=async sql=>{ if(sql.startsWith('INSERT'))throw Error('failed');return [{affectedRows:1}]; };
  await assert.rejects(reprints.record(pool,'INV','owner','A4'),/failed/);
  assert.equal(calls.at(-1),'rollback');
});
