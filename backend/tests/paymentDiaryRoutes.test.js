const test=require('node:test'),assert=require('node:assert/strict');
const express=require('express'),jwt=require('jsonwebtoken');
const calls=[];
require.cache[require.resolve('../config/db')]={exports:{}};
require.cache[require.resolve('../services/paymentDiary')]={exports:{createService:()=>({
  list:async()=>({rows:[]}),accounts:async()=>[],history:async()=>[],
  add:async(body,actor)=>{calls.push({body,actor});return{id:1};},
  pay:async(id,body,actor)=>{calls.push({id,body,actor});return{id:1};}
})}};
const {JWT_SECRET}=require('../middleware/auth');
test('diary API is restricted to Server/Admin and uses the authenticated actor',async t=>{
  const app=express();app.use(express.json());app.use('/diary',require('../routes/paymentDiary'));
  const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
  const base=`http://127.0.0.1:${server.address().port}/diary`;
  const headers=role=>({'Content-Type':'application/json',Authorization:'Bearer '+jwt.sign({role,username:'authenticated-admin'},JWT_SECRET)});
  assert.equal((await fetch(base)).status,401);
  assert.equal((await fetch(base,{headers:headers('COUNTER')})).status,403);
  assert.equal((await fetch(base,{headers:headers('SECURITY')})).status,403);
  assert.equal((await fetch(base,{headers:headers('ADMIN')})).status,200);
  const saved=await fetch(base+'/1/payments',{method:'POST',headers:headers('ADMIN'),body:JSON.stringify({created_by:'spoofed'})});
  assert.equal(saved.status,200);assert.equal(calls[0].actor,'authenticated-admin');
  assert.equal((await fetch(base+'/bad/payments',{method:'POST',headers:headers('ADMIN'),body:'{}'})).status,400);
});
