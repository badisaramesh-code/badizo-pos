'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const sku = require('../utils/basicSku');
const draft = {id:1,status:'DRAFT',details:{product_code:'TEST1',product_name:'Test product',unit_type:'Nos',mrp:20,sale_price:18,gst_percent:5,hsn_code:'1234'}};

function fixture({rows=[draft],failInsert=false,failCapture=false}={}) {
  const routes = new Map(), events = [], middleware=[];
  const connection = {
    async beginTransaction(){events.push('begin');}, async commit(){events.push('commit');},
    async rollback(){events.push('rollback');}, release(){events.push('release');},
    async query(sql,args) {
      if(sql.startsWith('SELECT * FROM basic_sku')) return [rows];
      if(sql.startsWith('INSERT INTO products')) { events.push('insert'); if(failInsert) throw Object.assign(Error('duplicate'),{code:'ER_DUP_ENTRY'}); return [{insertId:10}]; }
      if(sql.startsWith('UPDATE basic_sku')) {events.push('published');return [{affectedRows:1}];}
      throw Error('Unexpected SQL: '+sql);
    }
  };
  const router={get(p,...fn){routes.set('GET '+p,fn.at(-1));},post(p,...fn){routes.set('POST '+p,fn.at(-1));},use(...fn){middleware.push(...fn);}};
  const authenticate=()=>{}, authorize=(...roles)=>{assert.deepEqual(roles,['SERVER','ADMIN']);return 'roles';};
  const deps={express:{Router:()=>router},path,'../config/db':{getConnection:async()=>connection},'../middleware/auth':{authenticate,authorize},'../services/auditService':{writeAuditLog:async()=>events.push('audit')},'../utils/basicSku':sku,'../services/productMasterSync':{
    beginProductCapture:async(c,where,args)=>{assert.equal(c,connection);assert.equal(where,'barcode=?');assert.deepEqual(Array.from(args),['TEST1']);events.push('capture-before');return {};},
    finishProductCapture:async(c)=>{assert.equal(c,connection);events.push('capture-after');if(failCapture)throw Error('Outbox unavailable');}
  }};
  const context={require(name){if(!(name in deps))throw Error('Unexpected import '+name);return deps[name];},module:{exports:{}},__dirname:path.join(__dirname,'../routes')};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../routes/basicSku.js'),'utf8'),context);
  assert.deepEqual(middleware,[authenticate,'roles']);
  return {events,async publish(){let code=200,body;const response={status(n){code=n;return this;},json(value){body=value;return this;}};await routes.get('POST /publish')({body:{ids:[1]},user:{username:'test'}},response);return {code,body};}};
}

test('CSV supports quoted names, BOM and missing tax drafts',()=>{
  const [row]=sku.parseImport('\ufeffProduct Code,Product Name,Unit,MRP,Sale Price\r\nA,"Tea, loose",Nos,20,18');
  assert.equal(row.product_name,'Tea, loose');assert.deepEqual(sku.missing(row),['GST','HSN']);
});
test('CSV rejects duplicate codes, malformed CSV and invalid prices',()=>{
  const header='product_code,product_name,unit_type,mrp,sale_price\n';
  assert.throws(()=>sku.parseImport(header+'a,A,Nos,20,18\nA,B,Nos,20,18'),/Duplicate Product Code/);
  assert.throws(()=>sku.parseImport(header+'a,"Broken,Nos,20,18'),/unclosed quote/);
  assert.throws(()=>sku.parseImport(header+'a,A,Nos,20,21'),/no higher than MRP/);
  assert.throws(()=>sku.selectedIds([1,1]),/distinct/);
});
test('publish captures inserted product in the same transaction before marking draft published',async()=>{
  const f=fixture();assert.equal((await f.publish()).code,200);
  assert.deepEqual(f.events,['begin','capture-before','insert','capture-after','published','audit','commit','release']);
});
test('duplicate product and sync-outbox failure both roll back publication',async()=>{
  for(const option of [{failInsert:true},{failCapture:true}]) {
    const f=fixture(option);const response=await f.publish();assert.equal(response.code,option.failInsert?409:400);
    assert.ok(f.events.includes('rollback'));assert.ok(!f.events.includes('commit'));assert.ok(!f.events.includes('published'));assert.equal(f.events.at(-1),'release');
  }
});
test('missing tax and already published drafts cannot create products',async()=>{
  for(const row of [{...draft,details:{...draft.details,gst_percent:null}},{...draft,status:'PUBLISHED'}]) {
    const f=fixture({rows:[row]});assert.equal((await f.publish()).code,400);assert.deepEqual(f.events,['begin','rollback','release']);
  }
});
test('schema provision is additive and matches standalone migration',()=>{
  const {BASIC_SKU_DDL}=require('../services/basicSkuSchema');
  assert.match(BASIC_SKU_DDL,/CREATE TABLE IF NOT EXISTS/);assert.match(BASIC_SKU_DDL,/DEFAULT 'DRAFT'/);assert.doesNotMatch(BASIC_SKU_DDL,/DROP |AUTO_INCREMENT=\d/i);
  assert.equal(fs.readFileSync(path.join(__dirname,'../../database/migrations/basic-sku-drafts.sql'),'utf8').split('\n').slice(1).join('\n').trim(),BASIC_SKU_DDL);
});
