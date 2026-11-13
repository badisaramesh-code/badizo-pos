'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const express = require('express'), jwt = require('jsonwebtoken');
const { JWT_SECRET } = require('../middleware/auth');
const { createRouter } = require('../routes/backupRecovery');
test('upload/recover are SERVER-only and do not accept a database or command from the browser', async t => {
  const calls = [];
  const service = { status: async () => ({ configured: true }), receive: async (stream, value) => {
    const parts = []; for await (const part of stream) parts.push(part);
    calls.push({ ...value, body: Buffer.concat(parts).toString() }); return { id: 'uploaded' };
  }, request: async (body, actor) => { calls.push({ body, actor }); return { state: 'queued' }; } };
  const app = express(); app.use(express.json({ limit: '8kb' })); app.use('/recovery', createRouter(service));
  const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}/recovery`;
  const headers = role => ({ ...(role ? { Authorization: 'Bearer ' + jwt.sign({ role, username: 'owner' }, JWT_SECRET) } : {}), 'Content-Type': 'application/octet-stream' });
  for (const [role, code] of [[null, 401], ['COUNTER', 403], ['ADMIN', 403]]) {
    const response = await fetch(url + '/uploads?filename=daily.sql', { method: 'POST', headers: headers(role), body: 'SQL' }); assert.equal(response.status, code);
  }
  assert.equal(calls.length, 0);
  const denied = await fetch(url + '/uploads?filename=daily.sql&database=production', { method: 'POST', headers: headers('SERVER'), body: 'SQL' });
  assert.equal(denied.status, 400); assert.equal(calls.length, 0);
  const allowed = await fetch(url + '/uploads?filename=daily.sql', { method: 'POST', headers: headers('SERVER'), body: 'SQL' });
  assert.equal(allowed.status, 201); assert.equal(calls[0].actor, 'owner'); assert.equal(calls[0].body, 'SQL');
});
test('an interrupted upload releases its recovery lease only after cleanup settles',async()=>{
  const order=[];
  const router=createRouter({receive:async()=>{await Promise.resolve();order.push('cleanup');throw Error('aborted');}});
  const handler=router.stack.find(layer=>layer.route?.path==='/uploads').route.stack[0].handle;
  const request={headers:{'content-type':'application/octet-stream'},query:{filename:'daily.sql'},user:{username:'owner'},completeRecoveryWrite:()=>order.push('lease-released')};
  const response={status(){return this;},json(){order.push('response');}};
  await handler(request,response);
  assert.deepEqual(order,['cleanup','response','lease-released']);
});
