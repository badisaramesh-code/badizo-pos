const test=require('node:test'),assert=require('node:assert/strict'),express=require('express'),crypto=require('node:crypto');
const {createSyncHttpTransport}=require('../services/syncHttpTransport');
const {createRouter}=require('../routes/syncReceiver');
test('transport rejects insecure endpoints, embedded credentials and weak tokens',()=>{
  const token='a'.repeat(64);
  for(const url of ['http://example.com/sync','https://user:pass@example.com/sync','https://example.com/sync?token=secret'])assert.throws(()=>createSyncHttpTransport({url,token}));
  assert.throws(()=>createSyncHttpTransport({url:'https://example.com/sync',token:'weak'}));
});
test('receiver authenticates before processing and defaults to rejecting incoming writes',async t=>{
  const token=crypto.randomBytes(32).toString('hex');let calls=0,allowed=false;
  const app=express();app.use('/sync',createRouter({token,mayReceive:async()=>allowed,receive:async event=>{calls++;return {eventId:event.eventId,committed:true,duplicate:false};}}));
  const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
  const url=`http://127.0.0.1:${server.address().port}/sync`;
  const request=(credential,body)=>fetch(url,{method:'POST',headers:{Authorization:`Bearer ${credential}`,'Content-Type':'application/json'},body});
  assert.equal((await request('invalid','{}')).status,401);assert.equal(calls,0);
  assert.equal((await request(token,'{}')).status,409);assert.equal(calls,0);allowed=true;
  assert.equal((await request(token,'{bad')).status,400);assert.equal(calls,0);
  assert.equal((await request(token,JSON.stringify({eventId:'example'}))).status,200);assert.equal(calls,1);
});
