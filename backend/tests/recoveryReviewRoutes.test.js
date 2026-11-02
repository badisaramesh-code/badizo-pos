const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const express = require('express');
const jwt = require('jsonwebtoken');
const { JWT_SECRET } = require('../middleware/auth');
const { createRecoveryReviewStore } = require('../services/recoveryReviewStore');
const { createRouter } = require('../routes/recoveryReview');
test('owner review API enforces identity, rejects forged authors and retains safe state', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(),'badizo-review-api-'));
  t.after(()=>fs.rm(directory,{recursive:true,force:true}));
  const store=createRecoveryReviewStore({directory,shopId:'HFM001'});
  const {plan}=await store.create({shopId:'HFM001',baselineId:'seed',localCheckpoint:'l1',cloudCheckpoint:'c1',fields:[
    {kind:'product',recordId:'p1',field:'sale_price',base:1,local:2,cloud:3}
  ]});
  const app=express(); app.use(express.json({limit:'1mb'}));
  app.use('/review',createRouter({store,shopId:'HFM001'}));
  app.use('/wrong-shop',createRouter({store,shopId:'HFM002'}));
  const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  const base=`http://127.0.0.1:${server.address().port}`;
  const request=(role,url,body)=>fetch(base+url,{method:body?'POST':'GET',headers:{'Content-Type':'application/json',...(role?{Authorization:`Bearer ${jwt.sign({role,username:'actual-owner'},JWT_SECRET)}`}:{})},...(body?{body:JSON.stringify(body)}:{})});
  const url=`/review/${plan.id}`,choice={expectedRevision:0,side:'local',conflictIds:[plan.entries[0].id]};
  assert.equal((await request(null,url)).status,401);
  assert.equal((await request('COUNTER','/review')).status,403);
  const listing=await request('SERVER','/review');
  assert.equal(listing.status,200);
  assert.equal((await listing.json()).reviews[0].id,plan.id);
  for(const role of ['ADMIN','COUNTER','SECURITY']) assert.equal((await request(role,url)).status,403);
  const read=await request('SERVER',url);assert.equal(read.status,200);assert.equal(read.headers.get('cache-control'),'no-store');
  assert.equal((await request('SERVER',`/wrong-shop/${plan.id}`)).status,409);
  assert.equal((await request('SERVER',url+'/decisions',{...choice,actor:'forged'})).status,400);
  const response=await request('SERVER',url+'/decisions',choice);assert.equal(response.status,200);
  const review=await response.json();assert.equal(review.decisions[0].actor,'actual-owner');assert.equal(review.safeToResumeLocal,false);assert.equal(review.applied,false);
  assert.equal((await request('SERVER',url+'/decisions',choice)).status,409);
  assert.equal((await request('SERVER','/review/not-a-plan')).status,400);
  assert.equal((await request('SERVER',url+'/activate',{})).status,404);
});

