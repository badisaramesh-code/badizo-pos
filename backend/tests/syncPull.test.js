const test=require('node:test'),assert=require('node:assert/strict'),express=require('express');
const {createSyncPullClient}=require('../services/syncPullClient');
const {createRouter}=require('../routes/syncFeed');
test('pull refuses insecure endpoints and defaults to blocking local application',async()=>{
  const options={pool:{getConnection(){throw Error('Unexpected DB access');}},identity:{shopId:'HFM001',localInstallationId:'local-test',peerInstallationId:'cloud-test'},url:'https://example.invalid/feed',token:'a'.repeat(64),receive:async()=>{throw Error('Unexpected receive');}};
  for(const url of ['http://example.invalid','https://user:pass@example.invalid','https://example.invalid/?token=x'])assert.throws(()=>createSyncPullClient({...options,url}));
  await assert.rejects(createSyncPullClient(options)(),/currently blocked/);
});
test('cloud feed requires dedicated authentication and permission before reading or acknowledging',async t=>{
  let reads=0,acks=0,permitted=false;
  const app=express();app.use('/feed',createRouter({token:'a'.repeat(64),mayShare:async()=>permitted,feed:{pending:async()=>{reads++;return {events:[],hasMore:false};},acknowledge:async value=>{acks++;return {eventId:value.eventId,acknowledged:true};}}}));
  const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
  const base=`http://127.0.0.1:${server.address().port}/feed`;
  assert.equal((await fetch(base+'/pending')).status,401);
  const headers={Authorization:'Bearer '+'a'.repeat(64),'Content-Type':'application/json'};
  assert.equal((await fetch(base+'/pending',{headers})).status,409);
  assert.equal((await fetch(base+'/ack',{method:'POST',headers,body:'{}'})).status,409);assert.equal(reads+acks,0);
  permitted=true;assert.equal((await fetch(base+'/pending',{headers})).status,200);assert.equal(reads,1);
  assert.equal((await fetch(base+'/ack',{method:'POST',headers,body:JSON.stringify({oversized:'x'.repeat(3000)})})).status,413);assert.equal(acks,0);
});
