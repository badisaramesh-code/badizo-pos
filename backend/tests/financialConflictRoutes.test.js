const test=require('node:test'),assert=require('node:assert/strict'),express=require('express'),jwt=require('jsonwebtoken');
const {createRouter}=require('../routes/financialConflicts');
const {JWT_SECRET}=require('../middleware/auth');
test('financial correction buttons require owner identity and exact confirmation, then release completed write leases',async t=>{
  const calls=[];let completed=0;
  const app=express();app.use(express.json());app.use((req,_res,next)=>{req.completeRecoveryWrite=()=>{completed++;};next();});
  app.use('/cases',createRouter({cases:{retry:async(id,options,callback)=>{calls.push({id,options});await callback({eventId:'original'});return {status:'resolved'};}},canApply:async()=>true,corrections:{enabled:true,matchPayment:async(event,options)=>{assert.equal(event.eventId,'original');assert.equal(options.actor,'real-owner');return {committed:true};}}}));
  const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
  const post=(role,body)=>fetch('http://127.0.0.1:'+server.address().port+'/cases/example/match-payment',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+jwt.sign({role,username:'real-owner'},JWT_SECRET)},body:JSON.stringify(body)});
  const body={expectedRevision:0,targetPaymentId:'12',note:'Verified one payment on the supplier statement',confirmation:'THESE ARE THE SAME PHYSICAL PAYMENT'};
  assert.equal((await post('ADMIN',body)).status,403);assert.equal((await post('SERVER',{...body,actor:'forged'})).status,400);assert.equal((await post('SERVER',{...body,confirmation:'accept all'})).status,400);
  assert.equal((await post('SERVER',body)).status,200);assert.equal(calls.length,1);assert.equal(calls[0].options.action,'match-supplier-payment');assert.equal(completed,3);
});
