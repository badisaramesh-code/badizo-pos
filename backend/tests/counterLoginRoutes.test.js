const test=require('node:test');
const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const {once}=require('node:events');
const express=require('express');
const jwt=require('jsonwebtoken');
const {JWT_SECRET}=require('../middleware/auth');
const salt='test-counter';
const password='qa-only-passphrase';
const user={id:13,username:'qa-cashier',counter_no:2,role:'COUNTER',is_active:1,
  password_hash:salt+':'+crypto.pbkdf2Sync(password,salt,100000,64,'sha512').toString('hex')};
let failHistory=false;
const events=[];
require.cache[require.resolve('../config/db')]={loaded:true,exports:{query:async(sql,params)=>{
  if(sql.includes('FROM users'))return [[...(params[0]===user.username?[user]:[])]];
  if(sql.includes('INSERT INTO user_session_events')){
    if(failHistory)throw Error('historical audit schema unavailable');
    events.push(params);return [{insertId:1}];
  }
  if(sql.includes('FROM app_settings'))return [[]];
  throw Error('Unexpected query');
}}};
require.cache[require.resolve('../services/logger')]={loaded:true,exports:{logInfo(){},logError(){}}};

test('counter login and logout exercise actual hashing, signed tokens, roles and session history',async t=>{
  const app=express();app.use(express.json());app.use('/auth',require('../routes/auth'));
  const server=app.listen(0,'127.0.0.1');await once(server,'listening');
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  const base='http://127.0.0.1:'+server.address().port+'/auth';
  const login=(supplied=password)=>fetch(base+'/login',{method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({username:user.username,password:supplied,system_no:3,counter_no:4,person_name:' QA Cashier '})});
  await t.test('inactive account and wrong password create no session',async()=>{
    user.is_active=0;
    assert.equal((await login()).status,401);
    user.is_active=1;
    assert.equal((await login('wrong')).status,401);
    assert.equal(events.length,0);
  });
  await t.test('selected counter differs from assigned counter and logout records same session',async()=>{
    const response=await login();assert.equal(response.status,200);
    const result=await response.json(),claims=jwt.verify(result.token,JWT_SECRET);
    assert.equal(claims.system_no,3);assert.equal(claims.counter_no,4);assert.equal(claims.login_counter_no,2);
    assert.equal(claims.person_name,'QA Cashier');assert.equal(claims.role,'COUNTER');
    assert.ok(!('password_hash' in claims));assert.ok(!('password_hash' in result.user));
    const headers={Authorization:'Bearer '+result.token};
    assert.equal((await fetch(base+'/session-events',{headers})).status,403);
    assert.equal((await fetch(base+'/logout',{method:'POST',headers})).status,200);
    assert.deepEqual(events.map(event=>[event[0],event[5],event[6]]),[[claims.session_id,4,'LOGIN'],[claims.session_id,4,'LOGOUT']]);
  });
  await t.test('missing history table after restore does not prevent cashiers logging in',async()=>{
    failHistory=true;
    const result=await login();assert.equal(result.status,200);
    assert.equal(jwt.verify((await result.json()).token,JWT_SECRET).username,user.username);
  });
});
